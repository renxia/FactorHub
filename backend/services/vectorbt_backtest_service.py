"""
基于 vectorbt 的回测服务
更准确、更高效的回测引擎
"""
import pandas as pd
import numpy as np
from typing import Dict, List, Optional
from datetime import datetime

try:
    import vectorbt as vbt
    VECTORBT_AVAILABLE = True
except ImportError:
    VECTORBT_AVAILABLE = False


class VectorBTBacktestService:
    """基于 vectorbt 的回测服务"""

    def __init__(self, initial_capital: float = 1000000, commission_rate: float = 0.0003, slippage: float = 0.0):
        """
        初始化回测服务

        Args:
            initial_capital: 初始资金，默认100万
            commission_rate: 手续费率，默认万三
            slippage: 滑点率，默认0（不考虑滑点）
        """
        if not VECTORBT_AVAILABLE:
            raise ImportError("vectorbt未安装，请运行: pip install vectorbt")

        self.initial_capital = initial_capital
        self.commission_rate = commission_rate
        self.slippage = slippage

    def single_factor_backtest(
        self,
        df: pd.DataFrame,
        factor_name: str,
        percentile: int = 50,
        direction: str = "long",
        n_quantiles: int = 5,
    ) -> Dict:
        """
        单因子分层回测（使用vectorbt）

        Args:
            df: 包含价格和因子数据的DataFrame，必须有 close 列和因子列
            factor_name: 因子名称
            percentile: 分位数阈值（0-100），用于做多/做空判断
            direction: 交易方向，"long"做多或"short"做空
            n_quantiles: 分层数量，默认5层

        Returns:
            Dict: 包含各层收益、整体收益、净值曲线等数据的字典
        """
        # 确保索引是 DatetimeIndex
        if not isinstance(df.index, pd.DatetimeIndex):
            df = df.copy()
            if "date" in df.columns:
                df = df.set_index("date")
            df.index = pd.to_datetime(df.index)

        # 1. 计算收益率
        df["returns"] = df["close"].pct_change()

        # 2. 计算因子分位数（滚动窗口252天）
        factor_rank = df[factor_name].rolling(252, min_periods=1).rank(pct=True)

        # 3. 生成分层信号
        percentile_threshold = percentile / 100.0
        if direction == "long":
            entries = factor_rank >= percentile_threshold
            exits = factor_rank < percentile_threshold  # 低于阈值时平仓
        else:
            entries = factor_rank <= percentile_threshold
            exits = factor_rank > percentile_threshold  # 高于阈值时平仓

        # 4. 计算各层收益
        quantile_returns = {}
        for q in range(n_quantiles):
            q_min = q / n_quantiles
            q_max = (q + 1) / n_quantiles
            layer_mask = (factor_rank >= q_min) & (factor_rank < q_max)
            layer_returns = df.loc[layer_mask, "returns"]
            quantile_returns[f"Q{q + 1}"] = layer_returns

        # 5. 创建回测结果（使用vectorbt的信号回测）
        # 创建Portfolio对象，设置手续费和滑点
        pf = vbt.Portfolio.from_signals(
            close=df["close"],
            entries=entries,
            exits=exits,  # 添加退出信号
            init_cash=self.initial_capital,
            freq="D",  # 日频
            cash_sharing=False,  # 不共享现金
            fees=self.commission_rate,  # 手续费率
            slippage=self.slippage,  # 滑点率
        )

        # 获取净值、收益和性能指标
        equity = pf.value()
        returns = pf.returns()
        returns_clean = returns.dropna()

        # 使用 VectorBT 的 stats() 方法获取所有指标
        stats = pf.stats()

        # 从 stats Series 中提取指标
        # VectorBT 返回的百分比值需要除以100转换为小数
        total_return = stats.get('Total Return [%]', 0) / 100.0
        annual_return = stats.get('Annual Return [%]', 0) / 100.0 if 'Annual Return [%]' in stats else 0.0

        # 波动率：如果 stats 中有则使用，否则手动计算
        if 'Volatility (Ann.) [%]' in stats:
            volatility = stats.get('Volatility (Ann.) [%]', 0) / 100.0
        else:
            # 对于多资产情况，计算组合收益率的波动率
            if isinstance(returns_clean, pd.DataFrame):
                # 取平均组合收益
                portfolio_returns = returns_clean.mean(axis=1)
                volatility = portfolio_returns.std() * np.sqrt(252) if len(portfolio_returns) > 0 else 0.0
            else:
                volatility = returns_clean.std() * np.sqrt(252) if len(returns_clean) > 0 else 0.0

        sharpe_ratio = stats.get('Sharpe Ratio', 0)
        sortino_ratio = stats.get('Sortino Ratio', 0)
        max_drawdown = stats.get('Max Drawdown [%]', 0) / 100.0
        calmar_ratio = stats.get('Calmar Ratio', 0)
        win_rate = stats.get('Win Rate [%]', 0) / 100.0

        # VaR 和 CVaR 需要自己计算
        if len(returns_clean) > 0:
            if isinstance(returns_clean, pd.DataFrame):
                # 对于多资产，计算组合级别的 VaR/CVaR
                portfolio_returns = returns_clean.mean(axis=1)
                var_95 = portfolio_returns.quantile(0.05)
                cvar_95 = portfolio_returns[portfolio_returns <= var_95].mean()
            else:
                var_95 = returns_clean.quantile(0.05)
                cvar_95 = returns_clean[returns_clean <= var_95].mean()
        else:
            var_95 = 0.0
            cvar_95 = 0.0

        # 计算交易次数
        trades_count = stats.get('Total Trades', 0)

        return {
            "quantile_returns": quantile_returns,
            "portfolio_returns": returns,
            "equity_curve": equity,
            "trades_count": int(trades_count),
            # 手动计算的指标
            "total_return": float(total_return),
            "annual_return": float(annual_return),
            "sharpe_ratio": float(sharpe_ratio),
            "sortino_ratio": float(sortino_ratio),
            "max_drawdown": float(max_drawdown),
            "calmar_ratio": float(calmar_ratio),
            "win_rate": float(win_rate),
            "volatility": float(volatility),
            "var_95": float(var_95),
            "cvar_95": float(cvar_95),
        }

    def multi_factor_backtest(
        self,
        df: pd.DataFrame,
        factor_names: List[str],
        weights: Optional[List[float]] = None,
        method: str = "equal_weight",
        percentile: int = 50,
        direction: str = "long",
        n_quantiles: int = 5,
    ) -> Dict:
        """
        多因子组合回测（使用vectorbt）

        Args:
            df: 包含价格和因子数据的DataFrame
            factor_names: 因子名称列表
            weights: 因子权重列表（可选）
            method: 权重分配方法，"equal_weight"等权重, "ic_weight" IC加权, "risk_parity"风险平价
            percentile: 分位数阈值（0-100）
            direction: 交易方向，"long"做多或"short"做空
            n_quantiles: 分层数量

        Returns:
            Dict: 回测结果
        """
        # 确保索引是 DatetimeIndex
        if not isinstance(df.index, pd.DatetimeIndex):
            df = df.copy()
            if "date" in df.columns:
                df = df.set_index("date")
            df.index = pd.to_datetime(df.index)

        # 1. 标准化因子值（z-score）
        for factor_name in factor_names:
            if factor_name in df.columns:
                factor_mean = df[factor_name].mean()
                factor_std = df[factor_name].std()
                if factor_std > 0:
                    df[f"{factor_name}_normalized"] = (df[factor_name] - factor_mean) / factor_std
                else:
                    df[f"{factor_name}_normalized"] = 0

        # 2. 计算因子组合得分
        normalized_factors = [f"{name}_normalized" for name in factor_names]

        if method == "equal_weight":
            # 等权重
            if weights is None:
                weights = [1.0 / len(normalized_factors)] * len(normalized_factors)
            df["composite_score"] = sum(df[nf] * w for nf, w in zip(normalized_factors, weights))

        elif method == "ic_weight":
            # IC加权（简化版：使用因子与收益的相关性作为权重）
            df["returns"] = df["close"].pct_change().shift(-1)
            ic_weights = []
            for factor_name in factor_names:
                norm_factor = f"{factor_name}_normalized"
                ic = df[[norm_factor, "returns"]].dropna().corr().iloc[0, 1]
                ic_weights.append(abs(ic) if not np.isnan(ic) else 1.0)

            # 归一化权重
            total_ic_weight = sum(ic_weights)
            if total_ic_weight > 0:
                ic_weights = [w / total_ic_weight for w in ic_weights]
            else:
                ic_weights = [1.0 / len(normalized_factors)] * len(normalized_factors)

            df["composite_score"] = sum(df[nf] * w for nf, w in zip(normalized_factors, ic_weights))

        elif method == "risk_parity":
            # 风险平价（简化版：使用因子波动率的倒数作为权重）
            vol_weights = []
            for factor_name in factor_names:
                norm_factor = f"{factor_name}_normalized"
                vol = df[norm_factor].std()
                vol_weights.append(1.0 / vol if vol > 0 else 1.0)

            # 归一化权重
            total_vol_weight = sum(vol_weights)
            if total_vol_weight > 0:
                vol_weights = [w / total_vol_weight for w in vol_weights]
            else:
                vol_weights = [1.0 / len(normalized_factors)] * len(normalized_factors)

            df["composite_score"] = sum(df[nf] * w for nf, w in zip(normalized_factors, vol_weights))

        else:
            # 默认等权重
            df["composite_score"] = df[normalized_factors].mean(axis=1)

        # 3. 使用组合得分进行回测
        return self.single_factor_backtest(
            df=df,
            factor_name="composite_score",
            percentile=percentile,
            direction=direction,
            n_quantiles=n_quantiles,
        )

    def cross_sectional_backtest(
        self,
        df: pd.DataFrame,
        factor_name: str,
        top_percentile: float = 0.2,
        direction: str = "long",
    ) -> Dict:
        """
        股票池横截面回测（使用vectorbt）

        Args:
            df: 包含多只股票数据的DataFrame
            factor_name: 因子名称
            top_percentile: 选择股票的百分比（0.2表示前20%）
            direction: "long"做多或"short"做空

        Returns:
            Dict: 回测结果
        """
        # 确保索引正确
        if "date" not in df.columns:
            df = df.reset_index()

        # 透视数据：将股票代码转为列
        price_df = df.pivot(index="date", columns="stock_code", values="close")
        factor_df = df.pivot(index="date", columns="stock_code", values=factor_name)

        # 确保索引是 DatetimeIndex
        price_df.index = pd.to_datetime(price_df.index)

        # 1. 计算收益率
        returns_df = price_df.pct_change()

        # 2. 每日选择股票（横截面排名）
        selected_stocks = {}
        for date in factor_df.index:
            # 计算该日期所有股票的因子排名
            factor_values = factor_df.loc[date].dropna()
            ranks = factor_values.rank(pct=True)

            # 选择股票
            if direction == "long":
                # 做多：选择排名前 (1-top_percentile) 的股票
                selected = ranks[ranks >= (1 - top_percentile)].index.tolist()
            else:
                # 做空：选择排名后 top_percentile 的股票
                selected = ranks[ranks <= top_percentile].index.tolist()

            selected_stocks[date] = selected

        # 3. 创建信号矩阵
        # 只有被选中的股票在该日期持有
        signals = pd.DataFrame(0, index=returns_df.index, columns=returns_df.columns)

        for date, selected in selected_stocks.items():
            if selected:  # 确保有股票被选中
                signals.loc[date, selected] = 1

        # 4. 使用vectorbt进行回测
        # 注意：vectorbt的entries表示持仓开始，exits表示持仓结束
        # 这里我们简化处理：每日调仓，所以entries=signals，exits=signals.shift(-1)
        pf = vbt.Portfolio.from_signals(
            close=price_df,
            entries=signals,
            exits=signals.shift(-1).fillna(0),
            init_cash=self.initial_capital,
            freq="D",
            cash_sharing=False,
            fees=self.commission_rate,  # 手续费率
            slippage=self.slippage,  # 滑点率
        )

        # 5. 获取结果
        equity = pf.value()
        returns = pf.returns()
        returns_clean = returns.dropna()

        # 使用 VectorBT 的 stats() 方法获取所有指标
        stats = pf.stats()

        # 从 stats Series 中提取指标
        # VectorBT 返回的百分比值需要除以100转换为小数
        total_return = stats.get('Total Return [%]', 0) / 100.0
        annual_return = stats.get('Annual Return [%]', 0) / 100.0 if 'Annual Return [%]' in stats else 0.0

        # 波动率：如果 stats 中有则使用，否则手动计算
        if 'Volatility (Ann.) [%]' in stats:
            volatility = stats.get('Volatility (Ann.) [%]', 0) / 100.0
        else:
            # 对于多资产情况，计算组合收益率的波动率
            if isinstance(returns_clean, pd.DataFrame):
                # 取平均组合收益
                portfolio_returns = returns_clean.mean(axis=1)
                volatility = portfolio_returns.std() * np.sqrt(252) if len(portfolio_returns) > 0 else 0.0
            else:
                volatility = returns_clean.std() * np.sqrt(252) if len(returns_clean) > 0 else 0.0

        sharpe_ratio = stats.get('Sharpe Ratio', 0)
        sortino_ratio = stats.get('Sortino Ratio', 0)
        max_drawdown = stats.get('Max Drawdown [%]', 0) / 100.0
        calmar_ratio = stats.get('Calmar Ratio', 0)
        win_rate = stats.get('Win Rate [%]', 0) / 100.0

        # VaR 和 CVaR 需要自己计算
        if len(returns_clean) > 0:
            if isinstance(returns_clean, pd.DataFrame):
                # 对于多资产，计算组合级别的 VaR/CVaR
                portfolio_returns = returns_clean.mean(axis=1)
                var_95 = portfolio_returns.quantile(0.05)
                cvar_95 = portfolio_returns[portfolio_returns <= var_95].mean()
            else:
                var_95 = returns_clean.quantile(0.05)
                cvar_95 = returns_clean[returns_clean <= var_95].mean()
        else:
            var_95 = 0.0
            cvar_95 = 0.0

        # 计算交易次数（每日调仓次数）
        trades_count = stats.get('Total Trades', len(selected_stocks))

        return {
            "portfolio_returns": returns,
            "equity_curve": equity,
            "trades_count": trades_count,
            "daily_selected_count": trades_count,
            # 手动计算的指标
            "total_return": float(total_return),
            "annual_return": float(annual_return),
            "sharpe_ratio": float(sharpe_ratio),
            "sortino_ratio": float(sortino_ratio),
            "max_drawdown": float(max_drawdown),
            "calmar_ratio": float(calmar_ratio),
            "win_rate": float(win_rate),
            "volatility": float(volatility),
            "var_95": float(var_95),
            "cvar_95": float(cvar_95),
        }

    def calculate_metrics(
        self, returns: pd.Series, equity_curve: pd.Series = None, annual_trading_days: int = 252, risk_free_rate: float = 0.03
    ) -> Dict:
        """
        计算性能指标

        Args:
            returns: 收益率序列
            equity_curve: 净值曲线（可选），如果提供则用它计算回撤，更准确
            annual_trading_days: 年化交易日数，默认252
            risk_free_rate: 无风险利率，默认3%

        Returns:
            Dict: 包含各种性能指标的字典
        """
        # 删除NaN值
        returns_clean = returns.dropna()

        if len(returns_clean) == 0:
            return self._empty_metrics()

        # 基础指标
        total_return = returns_clean.sum()  # vectorbt的收益是简单求和
        n_days = len(returns_clean)

        # 年化收益率
        if n_days > 0:
            annual_return = returns_clean.mean() * annual_trading_days
        else:
            annual_return = 0.0

        # 波动率（年化）
        volatility = returns_clean.std() * np.sqrt(annual_trading_days)

        # 夏普比率
        daily_rf = risk_free_rate / annual_trading_days
        excess_returns = returns_clean - daily_rf
        if volatility > 0:
            sharpe_ratio = excess_returns.mean() * annual_trading_days / volatility
        else:
            sharpe_ratio = 0.0

        # 最大回撤（优先使用净值曲线计算，更准确）
        if equity_curve is not None and len(equity_curve) > 0:
            # 使用传入的净值曲线计算
            equity_array = equity_curve.values if hasattr(equity_curve, 'values') else list(equity_curve.values())
            peak = pd.Series(equity_array).cummax()
            drawdown = (peak - pd.Series(equity_array)) / peak
            max_drawdown = drawdown.max()
        else:
            # 回退方案：从收益率序列计算净值曲线
            equity = self.initial_capital + returns_clean.cumsum()
            peak = equity.cummax()
            drawdown = (peak - equity) / peak
            max_drawdown = drawdown.max()

        # 卡玛比率（设置最小阈值避免除零）
        if max_drawdown > 0.0001:  # 回撤至少大于0.01%
            calmar_ratio = annual_return / max_drawdown
        else:
            # 如果回撤极小，根据收益率设置卡玛比率
            if annual_return > 0:
                calmar_ratio = 999.99  # 接近无穷大
            else:
                calmar_ratio = -999.99  # 负收益且无回撤，设置为很大的负数

        # 胜率
        win_rate = (returns_clean > 0).mean()

        # 索提诺比率（只考虑下行风险）
        downside_returns = returns_clean[returns_clean < 0]
        if len(downside_returns) > 0:
            downside_std = downside_returns.std() * np.sqrt(annual_trading_days)
            if downside_std > 0:
                sortino_ratio = (returns_clean.mean() * annual_trading_days - risk_free_rate) / downside_std
            else:
                sortino_ratio = 0.0
        else:
            sortino_ratio = 0.0

        # VaR (95%置信度)
        var_95 = returns_clean.quantile(0.05)

        # CVaR (条件VaR，平均损失)
        cvar_95 = returns_clean[returns_clean <= var_95].mean()

        return {
            "total_return": total_return,
            "annual_return": annual_return,
            "volatility": volatility,
            "sharpe_ratio": sharpe_ratio,
            "max_drawdown": max_drawdown,
            "calmar_ratio": calmar_ratio,
            "win_rate": win_rate,
            "sortino_ratio": sortino_ratio,
            "var_95": var_95,
            "cvar_95": cvar_95,
        }

    def _empty_metrics(self) -> Dict:
        """返回空的性能指标字典"""
        return {
            "total_return": 0.0,
            "annual_return": 0.0,
            "volatility": 0.0,
            "sharpe_ratio": 0.0,
            "max_drawdown": 0.0,
            "calmar_ratio": 0.0,
            "win_rate": 0.0,
            "sortino_ratio": 0.0,
            "var_95": 0.0,
            "cvar_95": 0.0,
        }


def check_vectorbt_available() -> bool:
    """检查vectorbt是否可用"""
    return VECTORBT_AVAILABLE
