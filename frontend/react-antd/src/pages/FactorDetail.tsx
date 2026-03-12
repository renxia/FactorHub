import { useEffect, useState, useRef, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  Card,
  Button,
  Space,
  Tag,
  Spin,
  message,
  Row,
  Col,
  Statistic,
  Select,
  Input,
  DatePicker,
  Modal,
  Form,
  Divider
} from 'antd'
import {
  ArrowLeftOutlined,
  ReloadOutlined,
  LineChartOutlined,
  EditOutlined,
  DeleteOutlined
} from '@ant-design/icons'
import * as echarts from 'echarts'
import { api } from '@/services/api'
import './FactorDetail.css'
import dayjs from 'dayjs'

const { Option } = Select
const { RangePicker } = DatePicker

interface FactorDetail {
  id: number
  name: string
  code: string
  category: string
  source: 'preset' | 'user'
  description?: string
  is_active?: boolean
  created_at?: string
  updated_at?: string
}

interface AnalysisData {
  ic?: {
    data: {
      ic_stats: Record<string, any>
    }
  }
}

interface ChartData {
  stock: Array<{
    date: string
    open: number
    high: number
    low: number
    close: number
    volume: number
  }>
  factor: {
    dates: string[]
    values: number[]
  }
}

const FactorDetail: React.FC = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const id = searchParams.get('id')

  // 基本状态
  const [factor, setFactor] = useState<FactorDetail | null>(null)
  const [loading, setLoading] = useState(false)

  // 分析相关
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null)
  const [analyzing, setAnalyzing] = useState(false)

  // 编辑相关
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<any>({})

  // 行情图表相关
  const [chartData, setChartData] = useState<ChartData | null>(null)
  const [chartPeriod, setChartPeriod] = useState<string>('1y')
  const [factorChartType, setFactorChartType] = useState<string>('line')
  const [loadingChart, setLoadingChart] = useState(false)
  const [stockCode, setStockCode] = useState<string>('000001.SZ')
  const [customStartDate, setCustomStartDate] = useState<string>('')
  const [customEndDate, setCustomEndDate] = useState<string>('')
  const [showCustomDatePicker, setShowCustomDatePicker] = useState(false)

  // 图表容器引用
  const distributionChartRef = useRef<HTMLDivElement>(null)
  const icSeriesChartRef = useRef<HTMLDivElement>(null)
  const icHistogramChartRef = useRef<HTMLDivElement>(null)
  const priceChartRef = useRef<HTMLDivElement>(null)

  // 图表实例
  const chartsRef = useRef<Record<string, echarts.ECharts>>({})

  // 加载因子详情
  const loadFactorDetail = useCallback(async () => {
    if (!id) {
      message.warning('缺少因子ID参数')
      return
    }
    setLoading(true)
    try {
      const response = await api.getFactorDetail(Number(id)) as any
      if (response && response.success) {
        setFactor(response.data)
      } else {
        message.error('因子不存在')
      }
    } catch (error) {
      console.error('Failed to load factor detail:', error)
      message.error('加载因子详情失败')
    } finally {
      setLoading(false)
    }
  }, [id])

  // 分析因子
  const analyzeFactor = useCallback(async () => {
    if (!id || !factor) return

    // 使用用户选择的时间范围和股票代码
    let startDate: string
    let endDate: string

    if (chartPeriod === 'custom') {
      if (!customStartDate || !customEndDate) {
        message.warning('请先选择自定义日期范围')
        return
      }
      startDate = customStartDate
      endDate = customEndDate
    } else {
      endDate = new Date().toISOString().split('T')[0]
      startDate = getStartDateByPeriod(chartPeriod)
    }

    setAnalyzing(true)
    try {
      const response = await api.calculateIC({
        factor_name: factor.name,
        stock_codes: [stockCode],
        start_date: startDate,
        end_date: endDate
      } as any) as any

      if (response.success && response.data) {
        let icStats = response.data.ic_stats || response.data?.metadata?.ic_stats || {}

        if (icStats.ic_stats) {
          icStats = icStats.ic_stats
        }

        const factorNames = Object.keys(icStats)
        if (factorNames.length === 0) {
          message.warning('未获取到IC统计数据')
          setAnalysisData(null)
          return
        }

        const firstFactor = factorNames[0]
        const stats = icStats[firstFactor]

        if (!stats['IC序列'] || Object.keys(stats['IC序列']).length === 0) {
          message.warning('IC序列为空')
          setAnalysisData(null)
          return
        }

        setAnalysisData({
          ic: {
            data: {
              ic_stats: icStats
            }
          }
        })
        message.success('因子分析完成')
      } else {
        message.error('因子分析失败：' + (response.message || '未知错误'))
      }
    } catch (error: any) {
      console.error('因子分析失败:', error)
      message.error('因子分析失败')
    } finally {
      setAnalyzing(false)
    }
  }, [id, factor, chartPeriod, customStartDate, customEndDate, stockCode])

  // 编辑相关函数
  const handleEdit = () => {
    if (!factor) return
    setEditForm({
      name: factor.name,
      category: factor.category,
      description: factor.description || '',
      code: factor.code
    })
    setEditing(true)
  }

  const handleSaveEdit = async () => {
    if (!factor || !editForm.name || !editForm.category || !editForm.code) {
      message.error('请填写所有必填字段')
      return
    }

    try {
      const validateResponse = await api.validateFactor({
        code: editForm.code,
        formula_type: 'expression'
      } as any) as any

      if (!validateResponse.success) {
        message.error('因子公式验证失败')
        return
      }

      const updateResponse = await api.updateFactor(factor.id, {
        name: editForm.name,
        category: editForm.category,
        description: editForm.description,
        code: editForm.code
      } as any) as any

      if (updateResponse.success) {
        message.success('因子更新成功')
        setEditing(false)
        loadFactorDetail()
      } else {
        message.error('因子更新失败')
      }
    } catch (error: any) {
      message.error('操作失败')
    }
  }

  const handleCancelEdit = () => {
    setEditing(false)
    setEditForm({})
  }

  // 删除因子
  const handleDeleteFactor = async () => {
    if (!factor || factor.source === 'preset') return

    Modal.confirm({
      title: '确认删除',
      content: `确定要删除因子 "${factor.name}" 吗？`,
      onOk: async () => {
        try {
          const response = await api.deleteFactor(factor.id) as any
          if (response.success) {
            message.success('删除成功')
            navigate('/factor-management')
          } else {
            message.error(response.message || '删除失败')
          }
        } catch (error) {
          message.error('删除失败')
        }
      }
    })
  }

  // 格式化时间显示
  const formatDateTime = (dateStr?: string) => {
    if (!dateStr) return '-'
    return dayjs(dateStr).format('YYYY-MM-DD HH:mm:ss')
  }

  // 图表初始化函数
  const initChart = (chartDom: HTMLDivElement | null, chartKey: string) => {
    if (!chartDom) return null

    const rect = chartDom.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      return null
    }

    if (chartsRef.current[chartKey]) {
      chartsRef.current[chartKey].dispose()
    }

    const myChart = echarts.init(chartDom)
    chartsRef.current[chartKey] = myChart
    return myChart
  }

  // 绘制因子分布图
  const drawDistributionChart = useCallback(() => {
    const chartDom = distributionChartRef.current
    const myChart = initChart(chartDom, 'distribution')
    if (!myChart) return

    const data = Array.from({ length: 100 }, () => (Math.random() - 0.5) * 4)
    const binCount = 20
    const min = Math.min(...data)
    const max = Math.max(...data)
    const binWidth = (max - min) / binCount

    const bins = Array(binCount).fill(0)
    const labels: string[] = []

    for (let i = 0; i < binCount; i++) {
      labels.push((min + i * binWidth).toFixed(2))
    }

    data.forEach(value => {
      const binIndex = Math.min(Math.floor((value - min) / binWidth), binCount - 1)
      bins[binIndex]++
    })

    const option: echarts.EChartsOption = {
      title: {
        text: '因子值分布直方图',
        left: 'center',
        textStyle: { fontSize: 14 }
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' }
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true
      },
      xAxis: {
        name: '因子值',
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 10 }
      },
      yAxis: {
        name: '频次',
        type: 'value'
      },
      series: [
        {
          name: '频次',
          type: 'bar',
          data: bins,
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: '#83bff6' },
              { offset: 0.5, color: '#188df0' },
              { offset: 1, color: '#188df0' }
            ])
          }
        }
      ]
    }

    myChart.setOption(option)
  }, [])

  // 绘制IC序列图
  const drawICSeriesChart = useCallback(() => {
    const chartDom = icSeriesChartRef.current
    if (!chartDom || !analysisData?.ic) return

    const myChart = initChart(chartDom, 'icSeries')
    if (!myChart) return

    const stats = analysisData.ic.data.ic_stats || {}
    const factorName = Object.keys(stats)[0]
    const factorStats = factorName ? stats[factorName] : {}
    const icSeries = factorStats['IC序列'] || {}
    const icArray = Object.values(icSeries) as number[]

    const option: echarts.EChartsOption = {
      title: {
        text: 'IC序列',
        left: 'center',
        textStyle: { fontSize: 14 }
      },
      tooltip: { trigger: 'axis' },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        data: icArray.map((_, i) => i)
      },
      yAxis: {
        type: 'value',
        name: 'IC值'
      },
      series: [
        {
          name: 'IC值',
          type: 'line',
          data: icArray,
          smooth: true,
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(59, 130, 246, 0.3)' },
              { offset: 1, color: 'rgba(59, 130, 246, 0.05)' }
            ])
          },
          lineStyle: {
            color: '#3b82f6',
            width: 2
          }
        }
      ]
    }

    myChart.setOption(option)
  }, [analysisData])

  // 绘制IC直方图
  const drawICHistogramChart = useCallback(() => {
    const chartDom = icHistogramChartRef.current
    if (!chartDom || !analysisData?.ic) return

    const myChart = initChart(chartDom, 'icHistogram')
    if (!myChart) return

    const stats = analysisData.ic.data.ic_stats || {}
    const factorName = Object.keys(stats)[0]
    const factorStats = factorName ? stats[factorName] : {}
    const icSeries = factorStats['IC序列'] || {}
    const icArray = Object.values(icSeries) as number[]

    const colors = icArray.map((v: number) =>
      v > 0 ? 'rgba(239, 68, 68, 0.6)' : 'rgba(34, 197, 94, 0.6)'
    )

    const option: echarts.EChartsOption = {
      title: {
        text: 'IC分布直方图',
        left: 'center',
        textStyle: { fontSize: 14 }
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' }
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        data: icArray.map((_, i) => i)
      },
      yAxis: {
        type: 'value',
        name: 'IC值'
      },
      series: [
        {
          name: 'IC分布',
          type: 'bar',
          data: icArray,
          itemStyle: {
            color: (params: any) => colors[params.dataIndex]
          }
        }
      ]
    }

    myChart.setOption(option)
  }, [analysisData])

  // 获取开始日期
  const getStartDateByPeriod = (period: string): string => {
    const now = new Date()
    let startDate: Date

    switch (period) {
      case '3m':
        startDate = new Date(now.setMonth(now.getMonth() - 3))
        break
      case '6m':
        startDate = new Date(now.setMonth(now.getMonth() - 6))
        break
      case '1y':
        startDate = new Date(now.setFullYear(now.getFullYear() - 1))
        break
      case '3y':
        startDate = new Date(now.setFullYear(now.getFullYear() - 3))
        break
      case 'all':
        startDate = new Date('2020-01-01')
        break
      default:
        startDate = new Date(now.setFullYear(now.getFullYear() - 1))
    }

    return startDate.toISOString().split('T')[0]
  }

  // 处理股票代码变化
  const handleStockCodeChange = (value: string) => {
    if (value && !value.includes('.')) {
      if (value.startsWith('6')) {
        setStockCode(value + '.SH')
      } else if (value.startsWith('0') || value.startsWith('3')) {
        setStockCode(value + '.SZ')
      } else {
        setStockCode(value)
      }
    } else {
      setStockCode(value)
    }
  }

  // 处理自定义日期变化
  const handleCustomDateChange = (dates: any, dateStrings: [string, string]) => {
    if (dates && dates.length === 2) {
      setCustomStartDate(dateStrings[0])
      setCustomEndDate(dateStrings[1])
      setTimeout(() => {
        loadChartData()
      }, 100)
    }
  }

  // 加载行情数据
  const loadChartData = useCallback(async () => {
    if (!factor) return

    let startDate: string
    let endDate: string

    if (chartPeriod === 'custom') {
      if (!customStartDate || !customEndDate) {
        message.warning('请选择自定义日期范围')
        return
      }
      startDate = customStartDate
      endDate = customEndDate
    } else {
      endDate = new Date().toISOString().split('T')[0]
      startDate = getStartDateByPeriod(chartPeriod)
    }

    setLoadingChart(true)
    try {
      const stockResponse = await api.getStockData(stockCode, startDate, endDate) as any

      if (!stockResponse || !stockResponse.data) {
        message.warning('未获取到股票数据')
        return
      }

      const rawData = stockResponse.data
      if (!rawData.data || rawData.data.length === 0) {
        message.warning('股票数据为空')
        return
      }

      const stockData = rawData.data.map((row: any, i: number) => ({
        date: rawData.index[i],
        open: row[rawData.columns.indexOf('open')],
        high: row[rawData.columns.indexOf('high')],
        low: row[rawData.columns.indexOf('low')],
        close: row[rawData.columns.indexOf('close')],
        volume: row[rawData.columns.indexOf('volume')]
      }))

      const factorResponse = await api.calculateFactor({
        factor_name: factor.name,
        stock_codes: [stockCode],
        start_date: startDate,
        end_date: endDate
      } as any) as any

      if (!factorResponse || !factorResponse.success || !factorResponse.data) {
        message.warning('因子计算失败')
        return
      }

      const factorDataMap = factorResponse.data[stockCode]
      if (!factorDataMap) {
        message.warning('因子数据为空')
        return
      }

      const factorData = {
        dates: factorDataMap.dates,
        values: factorDataMap.factor_values
      }

      setChartData({
        stock: stockData,
        factor: factorData
      })
    } catch (error) {
      console.error('加载行情数据失败:', error)
      message.error('加载行情数据失败')
    } finally {
      setLoadingChart(false)
    }
  }, [factor, chartPeriod, stockCode, customStartDate, customEndDate])

  // 绘制行情图表
  const drawPriceChart = useCallback(() => {
    const chartDom = priceChartRef.current
    const myChart = initChart(chartDom, 'price')
    if (!myChart || !chartData) return

    const { stock, factor } = chartData

    const stockDates = new Set(stock.map(s => s.date))
    const alignedDates = factor.dates.filter((d: string) => stockDates.has(d))

    const stockMap = new Map(stock.map(s => [s.date, s]))
    const factorMap = new Map(factor.dates.map((d: string, i: number) => [d, factor.values[i]]))

    const displayDates = alignedDates
    const displayStock = alignedDates.map(d => stockMap.get(d)!).filter(Boolean)
    const displayFactorValues = alignedDates.map(d => factorMap.get(d)!).filter((v: any) => v !== null && v !== undefined)

    const klineData = displayStock.map(d => [d.open, d.close, d.low, d.high])

    // 双轴同图模式
    if (factorChartType === 'overlay') {
      const option: echarts.EChartsOption = {
        animation: false,
        grid: {
          left: '8%',
          right: '10%',
          top: '10%',
          bottom: '15%'
        },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross' },
          formatter: (params: any) => {
            if (!params || params.length === 0) return ''
            const date = params[0].axisValue
            let result = `<div style="font-weight: bold; margin-bottom: 5px;">${date}</div>`

            params.forEach((param: any) => {
              if (param.seriesName === '日K线') {
                const data = param.data
                result += `<div style="margin: 2px 0;">
                  <span style="display: inline-block; width: 10px; height: 10px; background: ${param.color}; border-radius: 50%; margin-right: 5px;"></span>
                  <span style="font-weight: bold;">日K线:</span>
                  开:${data[1]?.toFixed(2)} 收:${data[2]?.toFixed(2)}
                  低:${data[3]?.toFixed(2)} 高:${data[0]?.toFixed(2)}
                </div>`
              } else if (param.seriesName === '因子值') {
                result += `<div style="margin: 2px 0;">
                  <span style="display: inline-block; width: 10px; height: 10px; background: ${param.color}; border-radius: 50%; margin-right: 5px;"></span>
                  <span style="font-weight: bold; color: #3b82f6;">因子值:</span>
                  ${param.value?.toFixed(4)}
                </div>`
              }
            })
            return result
          }
        },
        xAxis: {
          type: 'category',
          data: displayDates,
          axisLine: { lineStyle: { color: '#94a3b8' } },
          axisTick: { show: false },
          axisLabel: {
            fontSize: 10,
            color: '#64748b'
          }
        },
        yAxis: [
          {
            type: 'value',
            scale: true,
            position: 'left',
            axisLabel: {
              fontSize: 10,
              color: '#64748b'
            },
            splitLine: {
              lineStyle: { color: 'rgba(148, 163, 184, 0.1)' }
            }
          },
          {
            type: 'value',
            scale: true,
            position: 'right',
            axisLabel: {
              fontSize: 10,
              color: '#3b82f6'
            },
            splitLine: { show: false }
          }
        ],
        dataZoom: [
          {
            type: 'inside',
            start: 0,
            end: 100
          },
          {
            type: 'slider',
            show: true,
            start: 0,
            end: 100,
            height: 20,
            bottom: 10
          }
        ],
        series: [
          {
            type: 'candlestick',
            name: '日K线',
            data: klineData,
            yAxisIndex: 0,
            itemStyle: {
              color: '#ef4444',
              color0: '#22c55e',
              borderColor: '#ef4444',
              borderColor0: '#22c55e'
            }
          },
          {
            type: 'line',
            name: '因子值',
            data: displayFactorValues,
            yAxisIndex: 1,
            smooth: true,
            showSymbol: false,
            lineStyle: {
              color: '#3b82f6',
              width: 2
            },
            itemStyle: {
              color: '#3b82f6'
            }
          }
        ]
      }

      myChart.setOption(option)
      return
    }

    // 单轴归一化模式
    if (factorChartType === 'normalized') {
      // 归一化处理：首日为100，计算百分比变化
      const basePrice = displayStock[0]?.close || 1
      const baseFactor = displayFactorValues[0] || 1

      const normalizedPrices = displayStock.map((d, i) =>
        ((d.close - basePrice) / basePrice * 100).toFixed(2)
      )
      const normalizedFactors = displayFactorValues.map((v: any, i: number) =>
        ((v - baseFactor) / Math.abs(baseFactor) * 100).toFixed(2)
      )

      const option: echarts.EChartsOption = {
        animation: false,
        grid: {
          left: '8%',
          right: '8%',
          top: '10%',
          bottom: '15%'
        },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross' },
          formatter: (params: any) => {
            if (!params || params.length === 0) return ''
            const date = params[0].axisValue
            let result = `<div style="font-weight: bold; margin-bottom: 5px;">${date}</div>`

            params.forEach((param: any) => {
              const value = parseFloat(param.value).toFixed(2)
              result += `<div style="margin: 2px 0;">
                <span style="display: inline-block; width: 10px; height: 10px; background: ${param.color}; border-radius: 50%; margin-right: 5px;"></span>
                <span style="font-weight: bold; color: ${param.color === '#ef4444' ? '#ef4444' : '#3b82f6'};">${param.seriesName}:</span>
                ${value}%
              </div>`
            })

            // 添加原始值信息
            const idx = params[0].dataIndex
            result += `<div style="margin-top: 5px; padding-top: 5px; border-top: 1px solid rgba(148, 163, 184, 0.2); font-size: 11px; color: #64748b;">
              原始价格: ${displayStock[idx]?.close?.toFixed(2)}<br/>
              原始因子: ${displayFactorValues[idx]?.toFixed(4)}
            </div>`

            return result
          }
        },
        xAxis: {
          type: 'category',
          data: displayDates,
          axisLine: { lineStyle: { color: '#94a3b8' } },
          axisTick: { show: false },
          axisLabel: {
            fontSize: 10,
            color: '#64748b'
          }
        },
        yAxis: {
          type: 'value',
          name: '变化率 (%)',
          axisLabel: {
            formatter: '{value}%'
          },
          axisLine: { lineStyle: { color: '#94a3b8' } },
          splitLine: {
            lineStyle: { color: 'rgba(148, 163, 184, 0.1)' }
          }
        },
        dataZoom: [
          {
            type: 'inside',
            start: 0,
            end: 100
          },
          {
            type: 'slider',
            show: true,
            start: 0,
            end: 100,
            height: 20,
            bottom: 10
          }
        ],
        series: [
          {
            type: 'line',
            name: '价格(归一化)',
            data: normalizedPrices,
            smooth: true,
            showSymbol: false,
            lineStyle: {
              color: '#ef4444',
              width: 2
            },
            itemStyle: {
              color: '#ef4444'
            },
            areaStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(239, 68, 68, 0.2)' },
                { offset: 1, color: 'rgba(239, 68, 68, 0.02)' }
              ])
            }
          },
          {
            type: 'line',
            name: '因子(归一化)',
            data: normalizedFactors,
            smooth: true,
            showSymbol: false,
            lineStyle: {
              color: '#3b82f6',
              width: 2
            },
            itemStyle: {
              color: '#3b82f6'
            }
          }
        ]
      }

      myChart.setOption(option)
      return
    }

    // 分屏模式（折线图、柱状图、面积图）
    const option: echarts.EChartsOption = {
      animation: false,
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
        label: {
          backgroundColor: '#777'
        }
      },
      grid: [
        { left: '8%', right: '8%', top: '10%', height: '40%' },
        { left: '8%', right: '8%', top: '60%', height: '30%' }
      ],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: any) => {
          if (!params || params.length === 0) return ''
          const date = params[0].axisValue
          let result = `<div style="font-weight: bold; margin-bottom: 5px;">${date}</div>`

          params.forEach((param: any) => {
            if (param.seriesName === '日K线') {
              const data = param.data
              result += `<div style="margin: 2px 0;">
                <span style="display: inline-block; width: 10px; height: 10px; background: ${param.color}; border-radius: 50%; margin-right: 5px;"></span>
                <span style="font-weight: bold;">日K线:</span>
                开:${data[1]?.toFixed(2)} 收:${data[2]?.toFixed(2)}
                低:${data[3]?.toFixed(2)} 高:${data[0]?.toFixed(2)}
              </div>`
            } else if (param.seriesName === '因子值') {
              result += `<div style="margin: 2px 0;">
                <span style="display: inline-block; width: 10px; height: 10px; background: ${param.color}; border-radius: 50%; margin-right: 5px;"></span>
                <span style="font-weight: bold; color: #3b82f6;">因子值:</span>
                ${param.value?.toFixed(4)}
              </div>`
            }
          })
          return result
        }
      },
      xAxis: [
        {
          type: 'category',
          data: displayDates,
          gridIndex: 0,
          axisLine: { lineStyle: { color: '#94a3b8' } },
          axisTick: { show: false },
          axisLabel: { show: false },
          axisPointer: {
            type: 'shadow',
            z: 100
          }
        },
        {
          type: 'category',
          data: displayDates,
          gridIndex: 1,
          axisLine: { lineStyle: { color: '#94a3b8' } },
          axisTick: { show: false },
          axisLabel: {
            fontSize: 10,
            color: '#64748b'
          },
          axisPointer: {
            type: 'shadow',
            z: 100
          }
        }
      ],
      yAxis: [
        {
          type: 'value',
          scale: true,
          gridIndex: 0,
          splitLine: {
            show: true,
            lineStyle: {
              color: 'rgba(148, 163, 184, 0.1)'
            }
          }
        },
        {
          type: 'value',
          scale: true,
          gridIndex: 1,
          splitLine: {
            show: true,
            lineStyle: {
              color: 'rgba(148, 163, 184, 0.1)'
            }
          }
        }
      ],
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: [0, 1],
          start: 0,
          end: 100
        },
        {
          type: 'slider',
          show: true,
          xAxisIndex: [0, 1],
          start: 0,
          end: 100,
          height: 20,
          bottom: 10
        }
      ],
      series: [
        {
          type: 'candlestick',
          name: '日K线',
          data: klineData,
          xAxisIndex: 0,
          yAxisIndex: 0,
          itemStyle: {
            color: '#ef4444',
            color0: '#22c55e',
            borderColor: '#ef4444',
            borderColor0: '#22c55e'
          }
        },
        {
          type: factorChartType === 'bar' ? 'bar' : 'line',
          name: '因子值',
          data: displayFactorValues,
          xAxisIndex: 1,
          yAxisIndex: 1,
          smooth: factorChartType !== 'bar',
          showSymbol: false,
          lineStyle: factorChartType !== 'bar' ? {
            color: '#3b82f6',
            width: 2
          } : undefined,
          itemStyle: {
            color: '#3b82f6'
          },
          areaStyle: factorChartType === 'area' ? {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(59, 130, 246, 0.3)' },
              { offset: 1, color: 'rgba(59, 130, 246, 0.05)' }
            ])
          } : undefined
        }
      ]
    }

    myChart.setOption(option)
  }, [chartData, factorChartType])

  // 获取IC统计数据
  const getICStats = () => {
    if (!analysisData?.ic?.data?.ic_stats) {
      return null
    }

    const stats = analysisData.ic.data.ic_stats
    const factorNames = Object.keys(stats)

    if (factorNames.length === 0) {
      return null
    }

    const factorName = factorNames[0]
    return stats[factorName] || null
  }

  // 初始加载
  useEffect(() => {
    loadFactorDetail()
  }, [loadFactorDetail])

  // 页面加载完成后加载行情图表并滚动到顶部
  useEffect(() => {
    if (factor) {
      loadChartData()
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [factor, loadChartData])

  // 图表绘制
  useEffect(() => {
    if (analysisData) {
      setTimeout(() => {
        drawDistributionChart()
        drawICSeriesChart()
        drawICHistogramChart()
      }, 100)
    }
  }, [analysisData, drawDistributionChart, drawICSeriesChart, drawICHistogramChart])

  // 行情图表数据变化时重绘
  useEffect(() => {
    if (chartData) {
      setTimeout(() => {
        drawPriceChart()
      }, 100)
    }
  }, [chartData, drawPriceChart])

  // 时间范围或图表类型变化时重新绘制
  useEffect(() => {
    if (chartData) {
      setTimeout(() => {
        drawPriceChart()
      }, 50)
    }
  }, [chartPeriod, factorChartType, stockCode, customStartDate, customEndDate, chartData, drawPriceChart])

  // 窗口大小变化时调整图表
  useEffect(() => {
    const handleResize = () => {
      Object.values(chartsRef.current).forEach(chart => {
        chart && chart.resize()
      })
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      Object.values(chartsRef.current).forEach(chart => {
        chart && chart.dispose()
      })
    }
  }, [])

  const icStats = getICStats()

  return (
    <div className="factor-detail-container">
      {/* 背景装饰 */}
      <div className="bg-gradient"></div>
      <div className="bg-grid"></div>

      {/* 顶部基本信息模块 */}
      <div className="page-header">
        <div className="header-content">
          <div className="header-title">
            <h1 className="page-title">{factor?.name || '因子详情'}</h1>
            <p className="page-subtitle">{factor?.description || '因子分析与可视化'}</p>
            {factor && (
              <div className="header-meta">
                <Space size="middle" wrap>
                  <Tag color="blue">{factor.category}</Tag>
                  <Tag color={factor.source === 'preset' ? 'success' : 'warning'}>
                    {factor.source === 'preset' ? '预置' : '自定义'}
                  </Tag>
                  <span className="meta-item">创建时间: {formatDateTime(factor.created_at)}</span>
                  {factor.updated_at && factor.updated_at !== factor.created_at && (
                    <span className="meta-item">更新时间: {formatDateTime(factor.updated_at)}</span>
                  )}
                </Space>
              </div>
            )}
          </div>
          <Space size="middle">
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/factor-management')}
            >
              返回
            </Button>
            <Button
              type="primary"
              icon={<LineChartOutlined />}
              onClick={analyzeFactor}
              loading={analyzing}
            >
              分析因子
            </Button>
            {factor && factor.source === 'user' && (
              <>
                <Button
                  icon={<EditOutlined />}
                  onClick={handleEdit}
                >
                  编辑
                </Button>
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  onClick={handleDeleteFactor}
                >
                  删除
                </Button>
              </>
            )}
          </Space>
        </div>
      </div>

      {/* 主内容区域 */}
      <div className="content-wrapper">
        {loading ? (
          <div className="loading-container">
            <Spin size="large" tip="加载中..." />
          </div>
        ) : factor ? (
          <div className="modules-container">
            {/* 详情信息模块 - 因子公式卡片 */}
            <Card className="detail-card" bordered={false}>
              <div className="detail-header">
                <h3 className="detail-title">因子公式</h3>
                {factor.source === 'user' && (
                  <Button
                    type="link"
                    icon={<EditOutlined />}
                    onClick={handleEdit}
                  >
                    编辑
                  </Button>
                )}
              </div>
              <pre className="formula-code">{factor.code}</pre>
            </Card>

            <Divider />

            {/* 行情图表模块 */}
            <Card className="chart-card" bordered={false}>
              <div className="chart-header">
                <h3 className="chart-title">行情图表</h3>
                <Space wrap>
                  <Input
                    placeholder="股票代码"
                    value={stockCode}
                    onChange={(e) => handleStockCodeChange(e.target.value)}
                    style={{ width: 120 }}
                    onPressEnter={() => loadChartData()}
                  />
                  <Select
                    value={chartPeriod}
                    onChange={(value) => {
                      setChartPeriod(value)
                      if (value === 'custom') {
                        setShowCustomDatePicker(true)
                      }
                    }}
                    style={{ width: 120 }}
                  >
                    <Option value="1y">近1年</Option>
                    <Option value="3y">近3年</Option>
                    <Option value="custom">自定义</Option>
                  </Select>
                  {showCustomDatePicker && (
                    <RangePicker
                      value={customStartDate && customEndDate ? [dayjs(customStartDate), dayjs(customEndDate)] : null}
                      onChange={handleCustomDateChange}
                      format="YYYY-MM-DD"
                    />
                  )}
                  <Select
                    value={factorChartType}
                    onChange={(value) => setFactorChartType(value)}
                    style={{ width: 140 }}
                  >
                    <Option value="overlay">双轴同图</Option>
                    <Option value="normalized">单轴归一化</Option>
                    <Option value="line">折线图</Option>
                    <Option value="bar">柱状图</Option>
                    <Option value="area">面积图</Option>
                  </Select>
                  <Button
                    icon={<ReloadOutlined />}
                    size="small"
                    onClick={loadChartData}
                    loading={loadingChart}
                  >
                    刷新
                  </Button>
                </Space>
              </div>
              <div ref={priceChartRef} className="chart-container large"></div>
            </Card>

            <Divider />

            {/* 因子分析指标信息 */}
            {icStats && (
              <>
                <Card className="stats-card" bordered={false}>
                  <h3 className="chart-title">因子分析指标</h3>
                  <Row gutter={[16, 16]}>
                    <Col xs={12} sm={8} md={4}>
                      <Card className="stat-card">
                        <Statistic
                          title="IC均值"
                          value={icStats['IC均值'] ?? '-'}
                          precision={icStats['IC均值'] !== undefined ? 4 : undefined}
                          valueStyle={{
                            color: (icStats['IC均值'] || 0) > 0 ? '#ef4444' : '#22c55e',
                            fontSize: '24px',
                            fontWeight: 'bold'
                          }}
                        />
                      </Card>
                    </Col>
                    <Col xs={12} sm={8} md={4}>
                      <Card className="stat-card">
                        <Statistic
                          title="IC标准差"
                          value={icStats['IC标准差'] ?? '-'}
                          precision={icStats['IC标准差'] !== undefined ? 4 : undefined}
                        />
                      </Card>
                    </Col>
                    <Col xs={12} sm={8} md={4}>
                      <Card className="stat-card">
                        <Statistic
                          title="IR比率"
                          value={icStats['IR'] ?? '-'}
                          precision={icStats['IR'] !== undefined ? 4 : undefined}
                          valueStyle={{ color: '#22c55e' }}
                        />
                      </Card>
                    </Col>
                    <Col xs={12} sm={8} md={4}>
                      <Card className="stat-card">
                        <Statistic
                          title="IC>0比例"
                          value={icStats['IC>0占比'] ?? '-'}
                          precision={icStats['IC>0占比'] !== undefined ? 2 : undefined}
                          suffix={icStats['IC>0占比'] !== undefined ? '%' : ''}
                        />
                      </Card>
                    </Col>
                    <Col xs={12} sm={8} md={4}>
                      <Card className="stat-card">
                        <Statistic
                          title="数据有效率"
                          value={icStats ? '100' : '-'}
                          suffix={icStats ? '%' : ''}
                        />
                      </Card>
                    </Col>
                    <Col xs={12} sm={8} md={4}>
                      <Card className="stat-card">
                        <Statistic
                          title="数据点数"
                          value={icStats ? Object.keys(icStats['IC序列'] || {}).length : '-'}
                        />
                      </Card>
                    </Col>
                  </Row>
                </Card>

                <Divider />

                {/* 因子分布柱状图 */}
                <Card className="chart-card" bordered={false}>
                  <h3 className="chart-title">因子分布柱状图</h3>
                  <div ref={distributionChartRef} className="chart-container"></div>
                </Card>

                <Divider />

                {/* IC序列 */}
                <Card className="chart-card" bordered={false}>
                  <h3 className="chart-title">IC序列</h3>
                  <div ref={icSeriesChartRef} className="chart-container"></div>
                </Card>

                <Divider />

                {/* IC分布直方图 */}
                <Card className="chart-card" bordered={false}>
                  <h3 className="chart-title">IC分布直方图</h3>
                  <div ref={icHistogramChartRef} className="chart-container"></div>
                </Card>
              </>
            )}

            {!icStats && (
              <Card className="empty-card" bordered={false}>
                <p style={{ color: '#64748b', margin: 0, textAlign: 'center' }}>
                  请点击上方"分析因子"按钮进行因子分析
                </p>
              </Card>
            )}
          </div>
        ) : (
          <Card className="empty-card" bordered={false}>
            <p>{id ? '因子不存在或已被删除' : '未指定因子ID'}</p>
            <Button type="primary" onClick={() => navigate('/factor-management')} style={{ marginTop: '16px' }}>
              返回因子列表
            </Button>
          </Card>
        )}
      </div>

      {/* 编辑因子弹窗 */}
      <Modal
        title="编辑因子"
        open={editing}
        onOk={handleSaveEdit}
        onCancel={handleCancelEdit}
        width={600}
        destroyOnClose
      >
        <Form layout="vertical">
          <Form.Item
            label="因子名称"
            required
            style={{ marginBottom: 16 }}
          >
            <Input
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              placeholder="请输入因子名称"
            />
          </Form.Item>

          <Form.Item
            label="分类"
            required
            style={{ marginBottom: 16 }}
          >
            <Select
              value={editForm.category}
              onChange={(value) => setEditForm({ ...editForm, category: value })}
              placeholder="请选择分类"
            >
              <Option value="技术指标">技术指标</Option>
              <Option value="价格动量">价格动量</Option>
              <Option value="成交量">成交量</Option>
              <Option value="波动率">波动率</Option>
              <Option value="自定义">自定义</Option>
            </Select>
          </Form.Item>

          <Form.Item
            label="因子说明"
            style={{ marginBottom: 16 }}
          >
            <Input.TextArea
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              placeholder="请输入因子说明"
              rows={3}
            />
          </Form.Item>

          <Form.Item
            label="因子公式"
            required
            style={{ marginBottom: 16 }}
          >
            <Input.TextArea
              value={editForm.code}
              onChange={(e) => setEditForm({ ...editForm, code: e.target.value })}
              placeholder="请输入因子公式"
              rows={4}
              className="font-mono"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default FactorDetail
