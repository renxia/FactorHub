import { Card, Empty } from 'antd'

const PortfolioAnalysis: React.FC = () => {
  return (
    <div style={{ padding: '24px' }}>
      <Card variant="borderless" style={{ background: 'rgba(255, 255, 255, 0.8)', border: '1px solid rgba(59, 130, 246, 0.15)', borderRadius: '16px', backdropFilter: 'blur(20px)', boxShadow: '0 4px 20px rgba(59, 130, 246, 0.08)' }}>
        <Empty description="功能开发中，敬请期待..." style={{ color: '#64748b' }} />
      </Card>
    </div>
  )
}

export default PortfolioAnalysis
