"""
组合分析API路由
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Optional
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from backend.services.portfolio_analysis_service import portfolio_analysis_service

router = APIRouter()


def convert_numpy_types(obj):
    """
    递归转换 numpy 类型为 Python 原生类型
    """
    if isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        # 处理特殊值
        if np.isnan(obj):
            return 0.0
        elif np.isinf(obj):
            return 0.0
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return [convert_numpy_types(x) for x in obj]
    elif isinstance(obj, dict):
        return {k: convert_numpy_types(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [convert_numpy_types(x) for x in obj]
    else:
        return obj


# ========== 数据模型 ==========

class OptimizeWeightsRequest(BaseModel):
    """权重优化请求"""
    stock_code: str
    factors: List[str]
    start_date: str
    end_date: str
    method: str = "equal_weight"
    rebalance_freq: str = "monthly"


class CompositeScoreRequest(BaseModel):
    """计算综合得分请求"""
    stock_code: str
    factors: List[str]
    start_date: str
    end_date: str


class CompareMethodsRequest(BaseModel):
    """对比权重方法请求"""
    stock_code: str
    factors: List[str]
    start_date: str
    end_date: str
    methods: List[str] = ["equal_weight", "ic_weight"]


# ========== API端点 ==========

@router.post("/optimize-weights")
async def optimize_weights(request: OptimizeWeightsRequest):
    """优化权重"""
    try:
        from backend.services.data_service import data_service
        from backend.services.factor_service import factor_service
        from backend.repositories.factor_repository import FactorRepository
        from backend.core.database import get_db_session
        import pandas as pd
        import numpy as np

        # 获取股票数据
        stock_data = data_service.get_stock_data(
            request.stock_code,
            request.start_date,
            request.end_date
        )

        if stock_data is None or len(stock_data) == 0:
            raise HTTPException(status_code=404, detail="未获取到数据")

        # 从数据库获取因子定义
        db = get_db_session()
        repo = FactorRepository(db)
        factor_defs = {}
        for factor_name in request.factors:
            factor = repo.get_by_name(factor_name)
            if factor:
                factor_defs[factor_name] = factor
        db.close()

        if not factor_defs:
            raise HTTPException(status_code=400, detail="未找到任何有效的因子定义")

        # 计算所有因子的值
        factor_values = {}
        for factor_name, factor_def in factor_defs.items():
            try:
                values = factor_service.calculator.calculate(stock_data, factor_def.code)
                if values is not None and len(values.dropna()) > 0:
                    factor_values[factor_name] = values
            except Exception as e:
                continue

        if not factor_values:
            raise HTTPException(status_code=400, detail="没有有效的因子数据")

        # 计算收益率序列（用于权重优化）
        returns = stock_data['close'].pct_change().shift(-1)  # 未来收益率

        # 根据方法计算权重
        n_factors = len(request.factors)

        if request.method == "equal_weight":
            # 等权重
            weights = {f: 1.0/n_factors for f in request.factors}

        elif request.method == "ic_weight":
            # IC加权：根据每个因子的IC值加权
            ic_values = {}
            for factor_name, values in factor_values.items():
                # 对齐数据
                aligned_factor = values.dropna()
                aligned_returns = returns.loc[aligned_factor.index].dropna()
                common_index = aligned_factor.index.intersection(aligned_returns.index)

                if len(common_index) > 10:
                    # 计算IC（因子值与未来收益率的相关系数）
                    ic = aligned_factor.loc[common_index].corr(aligned_returns.loc[common_index])
                    ic_values[factor_name] = abs(ic) if not np.isnan(ic) else 0
                else:
                    ic_values[factor_name] = 0

            # 根据IC值加权
            total_ic = sum(ic_values.values())
            if total_ic > 0:
                weights = {f: ic_values.get(f, 0) / total_ic for f in request.factors}
            else:
                weights = {f: 1.0/n_factors for f in request.factors}

        elif request.method == "ir_weight":
            # IR加权：根据每个因子的IR值加权（IC均值/IC标准差）
            ir_values = {}
            for factor_name, values in factor_values.items():
                # 对齐数据
                aligned_factor = values.dropna()
                aligned_returns = returns.loc[aligned_factor.index].dropna()
                common_index = aligned_factor.index.intersection(aligned_returns.index)

                if len(common_index) > 20:
                    # 计算滚动IC
                    ic_series = aligned_factor.loc[common_index].rolling(
                        window=20, min_periods=10
                    ).corr(aligned_returns.loc[common_index])

                    # IR = IC均值 / IC标准差
                    ic_mean = ic_series.mean()
                    ic_std = ic_series.std()
                    ir = ic_mean / ic_std if ic_std > 0 else 0
                    ir_values[factor_name] = abs(ir) if not np.isnan(ir) else 0
                else:
                    ir_values[factor_name] = 0

            # 根据IR值加权
            total_ir = sum(ir_values.values())
            if total_ir > 0:
                weights = {f: ir_values.get(f, 0) / total_ir for f in request.factors}
            else:
                weights = {f: 1.0/n_factors for f in request.factors}

        elif request.method == "max_sharpe":
            # 最大夏普比率：简化实现，使用IC/波动率作为代理
            sharpe_values = {}
            for factor_name, values in factor_values.items():
                # 对齐数据
                aligned_factor = values.dropna()
                aligned_returns = returns.loc[aligned_factor.index].dropna()
                common_index = aligned_factor.index.intersection(aligned_returns.index)

                if len(common_index) > 10:
                    # 计算IC
                    ic = aligned_factor.loc[common_index].corr(aligned_returns.loc[common_index])
                    # 计算因子波动率作为风险代理
                    factor_vol = aligned_factor.std()
                    # 简化的夏普比率 = IC / 波动率
                    sharpe = abs(ic) / factor_vol if factor_vol > 0 else 0
                    sharpe_values[factor_name] = sharpe if not np.isnan(sharpe) else 0
                else:
                    sharpe_values[factor_name] = 0

            # 根据夏普比率加权
            total_sharpe = sum(sharpe_values.values())
            if total_sharpe > 0:
                weights = {f: sharpe_values.get(f, 0) / total_sharpe for f in request.factors}
            else:
                weights = {f: 1.0/n_factors for f in request.factors}

        elif request.method == "max_return":
            # 最大收益：根据因子值与收益率的回归系数加权
            return_values = {}
            for factor_name, values in factor_values.items():
                # 对齐数据
                aligned_factor = values.dropna()
                aligned_returns = returns.loc[aligned_factor.index].dropna()
                common_index = aligned_factor.index.intersection(aligned_returns.index)

                if len(common_index) > 10:
                    # 计算因子与收益率的协方差作为预测力代理
                    cov = aligned_factor.loc[common_index].cov(aligned_returns.loc[common_index])
                    return_values[factor_name] = abs(cov) if not np.isnan(cov) else 0
                else:
                    return_values[factor_name] = 0

            # 根据预测力加权
            total_return = sum(return_values.values())
            if total_return > 0:
                weights = {f: return_values.get(f, 0) / total_return for f in request.factors}
            else:
                weights = {f: 1.0/n_factors for f in request.factors}

        elif request.method == "min_variance":
            # 最小方差：根据因子值的方差反向加权（波动率越小权重越大）
            variance_values = {}
            for factor_name, values in factor_values.items():
                # 计算因子方差
                var = values.var()
                variance_values[factor_name] = 1.0 / (var + 1e-8) if not np.isnan(var) and var > 0 else 1.0

            # 根据方差倒数加权
            total_var = sum(variance_values.values())
            if total_var > 0:
                weights = {f: variance_values.get(f, 0) / total_var for f in request.factors}
            else:
                weights = {f: 1.0/n_factors for f in request.factors}

        else:
            # 默认等权重
            weights = {f: 1.0/n_factors for f in request.factors}

        # 归一化权重
        total_weight = sum(weights.values())
        weights = {k: v/total_weight for k, v in weights.items()}

        # 计算组合因子值和性能指标
        # 构建DataFrame用于计算，使用 stock_data 的索引
        factor_df = pd.DataFrame(index=stock_data.index)

        for factor_name, values in factor_values.items():
            factor_df[factor_name] = values

        # 计算加权组合因子
        weighted_factor = pd.Series(index=factor_df.index, dtype=float).fillna(0)
        for factor_name, weight in weights.items():
            if factor_name in factor_df.columns:
                weighted_factor += factor_df[factor_name].fillna(0) * weight

        weighted_factor = weighted_factor.dropna()

        # 计算未来收益率（用于IC计算）
        returns = stock_data['close'].pct_change().shift(-1)

        # 对齐数据 - 使用共同的索引
        common_index = weighted_factor.index.intersection(returns.index)

        if len(common_index) < 3:
            raise HTTPException(status_code=400, detail=f"有效数据点太少（{len(common_index)}个），无法计算组合指标")

        aligned_factor = weighted_factor.loc[common_index]
        aligned_returns = returns.loc[common_index]

        # 移除 NaN 值
        valid_mask = ~(aligned_factor.isna() | aligned_returns.isna())
        aligned_factor = aligned_factor[valid_mask]
        aligned_returns = aligned_returns[valid_mask]

        if len(aligned_factor) > 3:
            # 计算组合IC
            portfolio_ic = aligned_factor.corr(aligned_returns)

            # 计算组合收益率（因子的平均收益）
            portfolio_return = aligned_returns.mean()

            # 计算组合IR (IC均值 / IC标准差)
            ic_series = aligned_factor.rolling(window=20, min_periods=10).corr(aligned_returns)
            ic_mean = ic_series.mean()
            ic_std = ic_series.std()
            portfolio_ir = ic_mean / ic_std if ic_std > 0 else 0
        else:
            portfolio_ic = 0
            portfolio_return = 0
            portfolio_ir = 0

        result = {
            "weights": weights,
            "method": request.method,
            "factors": request.factors,
            "metrics": {
                "return": float(portfolio_return),
                "ic": float(portfolio_ic),
                "ir": float(portfolio_ir)
            }
        }

        # 转换 numpy 类型为 Python 原生类型，以避免 JSON 序列化错误
        result = convert_numpy_types(result)

        return {
            "success": True,
            "data": result
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/composite-score")
async def calculate_composite_score(request: CompositeScoreRequest):
    """计算综合得分"""
    try:
        from backend.services.data_service import data_service
        from backend.services.factor_service import factor_service
        from backend.repositories.factor_repository import FactorRepository
        from backend.core.database import get_db_session
        import pandas as pd

        # 获取股票数据
        stock_data = data_service.get_stock_data(
            request.stock_code,
            request.start_date,
            request.end_date
        )

        if stock_data is None or len(stock_data) == 0:
            raise HTTPException(status_code=404, detail="未获取到数据")

        # 从数据库获取因子定义
        db = get_db_session()
        repo = FactorRepository(db)
        factor_defs = {}
        for factor_name in request.factors:
            factor = repo.get_by_name(factor_name)
            if factor:
                factor_defs[factor_name] = factor
        db.close()

        if not factor_defs:
            raise HTTPException(status_code=400, detail="未找到任何有效的因子定义")

        # 计算所有因子的值
        factor_data = {}
        for factor_name, factor_def in factor_defs.items():
            try:
                values = factor_service.calculator.calculate(stock_data, factor_def.code)
                if values is not None:
                    factor_data[factor_name] = values
            except Exception as e:
                print(f"计算因子 {factor_name} 失败: {e}")
                continue

        if not factor_data:
            raise HTTPException(status_code=400, detail="没有有效的因子数据")

        # 使用等权重（简化）
        weights = {f: 1.0/len(factor_data) for f in factor_data.keys()}

        # 调用综合得分计算
        result = portfolio_analysis_service.calculate_combined_factor_score(
            factor_data=factor_data,
            weights=weights,
            normalize=True
        )

        # 转换为列表
        if hasattr(result, 'index'):
            score_list = {
                "dates": result.index.astype(str).tolist(),
                "values": result.values.tolist()
            }
        else:
            score_list = {"values": list(result)}

        # 转换 numpy 类型为 Python 原生类型，以避免 JSON 序列化错误
        score_list = convert_numpy_types(score_list)

        return {
            "success": True,
            "data": score_list
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/compare-methods")
async def compare_weight_methods(request: CompareMethodsRequest):
    """对比权重方法"""
    try:
        from backend.services.data_service import data_service
        from backend.services.factor_service import factor_service
        from backend.repositories.factor_repository import FactorRepository
        from backend.core.database import get_db_session
        import pandas as pd

        # 获取股票数据
        stock_data = data_service.get_stock_data(
            request.stock_code,
            request.start_date,
            request.end_date
        )

        if stock_data is None or len(stock_data) == 0:
            raise HTTPException(status_code=404, detail="未获取到数据")

        # 从数据库获取因子定义
        db = get_db_session()
        repo = FactorRepository(db)
        factor_defs = {}
        for factor_name in request.factors:
            factor = repo.get_by_name(factor_name)
            if factor:
                factor_defs[factor_name] = factor
        db.close()

        if not factor_defs:
            raise HTTPException(status_code=400, detail="未找到任何有效的因子定义")

        # 计算所有因子的值
        factor_data = {}
        for factor_name, factor_def in factor_defs.items():
            try:
                values = factor_service.calculator.calculate(stock_data, factor_def.code)
                if values is not None:
                    factor_data[factor_name] = values
            except Exception as e:
                print(f"计算因子 {factor_name} 失败: {e}")
                continue

        if not factor_data:
            raise HTTPException(status_code=400, detail="没有有效的因子数据")

        # 计算因子收益率（简化：使用价格变化率）
        factor_returns = {}
        for name, values in factor_data.items():
            # 将因子值转换为收益率（简化实现）
            returns = values.pct_change().dropna()
            factor_returns[name] = returns

        # 转换为DataFrame
        factor_returns_df = pd.DataFrame(factor_returns)

        # 调用方法对比
        result = portfolio_analysis_service.compare_weight_methods(
            factor_returns=factor_returns_df,
            methods=request.methods
        )

        # 转换 numpy 类型为 Python 原生类型，以避免 JSON 序列化错误
        result = convert_numpy_types(result)

        return {
            "success": True,
            "data": {
                "results": result
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
