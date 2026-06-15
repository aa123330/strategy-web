# ETH SIGNAL - ETH_USDT 公开行情策略信号网站

这是一个基于公开行情数据的 ETH_USDT 永续合约策略信号 Web 应用。项目当前定位是 **策略分析与开仓建议展示网站**，不需要输入交易所 API Key，不连接账户，不执行真实下单。

## 项目定位

本项目用于观察 ETH_USDT / ETH-USDT-SWAP 永续合约行情，并根据无未来函数的技术指标策略生成参考信号：

- 当前趋势判断
- 开仓方向建议
- 信号评分
- 置信度
- 入场参考价
- ATR 止损
- 止盈目标
- 风险收益比
- 信号依据
- 风险提示

> 本项目仅用于行情分析和策略研究，不构成投资建议，也不会自动下单。

## 当前功能

### 公开行情数据

应用使用交易所公开接口，不需要任何私有凭证：

- Gate Futures ETH_USDT
- Binance Futures ETHUSDT
- OKX ETH-USDT-SWAP

默认自动切换顺序：

```text
Gate WSS -> Binance WSS -> OKX WSS -> Gate HTTP 兜底
```

当 Gate 实时行情异常或长时间无数据时，会自动切换到 Binance / OKX 备用行情源，最后使用 HTTP K线兜底。

### K线图表

支持周期：

```text
1m / 5m / 15m / 1h / 4h / 1d
```

图表内容：

- K线主图
- MA 快线
- MA 慢线
- MACD 副图
- 数据源状态
- 当前信号摘要

### 策略信号

当前支持三种策略：

1. 综合评分策略，默认策略
2. 双均线策略
3. MACD 策略

## 综合评分策略说明

综合评分策略不使用未来函数，只基于当前及历史 K 线数据。

### 多头加分项

```text
MA 快线上穿慢线：+30
价格位于慢线之上：+20
MACD 多头排列且柱体增强：+25
成交量高于20周期均量：+10
ATR 波动率处于可交易区间：+10
```

如果价格接近 20 周期高点：

```text
做多追高风险：-8
```

### 空头加分项

```text
MA 快线下穿慢线：+30
价格位于慢线之下：+20
MACD 空头排列且柱体转弱：+25
成交量高于20周期均量：+10
ATR 波动率处于可交易区间：+10
```

如果价格接近 20 周期低点：

```text
做空追空风险：-8
```

### 开仓阈值

```text
评分 >= 65  -> 建议做多
评分 <= -65 -> 建议做空
其他情况   -> 观望
```

此外，ATR 波动率需要处于合理区间，否则策略会倾向观望，避免低波动假突破或高波动追单。

### 止损止盈逻辑

风险距离：

```text
riskDistance = max(ATR * 1.5, 当前价格 * 0.4%)
```

做多时：

```text
止损 = 入场价 - riskDistance
止盈1 = 入场价 + riskDistance * 2
止盈2 = 入场价 + riskDistance * 3
```

做空时：

```text
止损 = 入场价 + riskDistance
止盈1 = 入场价 - riskDistance * 2
止盈2 = 入场价 - riskDistance * 3
```

默认风险收益比：

```text
1 : 2
```

## 为什么不使用未来函数

未来函数会使用当前时刻之后才会出现的数据，例如未来几根 K 线的最高价、最低价或涨跌结果。这会导致回测看起来很好，但实盘完全不可用。

本项目策略只使用：

- 当前 K 线
- 历史 K 线
- 历史成交量
- 历史 ATR
- 历史均线
- 历史 MACD

不会使用未来数据。

## 技术栈

- React 19
- TypeScript
- Vite
- Zustand
- lightweight-charts v5
- lucide-react
- Tailwind CSS v4
- WebSocket

## 目录结构

```text
src/
  components/
    ChartView.tsx        图表与数据源状态
    Header.tsx           顶部导航
    SignalsView.tsx      策略信号面板
  hooks/
    useMarketData.ts     多交易所行情接入与自动切换
    useStrategySignal.ts 实时策略信号计算
  services/
    gateWs.ts            Gate WSS 行情
    binanceWs.ts         Binance WSS 行情
    okxWs.ts             OKX WSS 行情
    gatePublicApi.ts     Gate 公开 REST 接口
  store/
    index.ts             Zustand 全局状态
  strategies/
    compositeStrategy.ts 综合评分策略
    dualMa.ts            双均线策略
    macdStrategy.ts      MACD 策略
    indicators.ts        SMA / EMA / MACD / ATR 等指标
  utils/
    formatters.ts        格式化工具
```

## 快速开始

### 安装依赖

```bash
npm.cmd install
```

### 启动开发服务

```bash
npm.cmd run dev -- --port 5173 --strictPort
```

访问：

```text
http://localhost:5173/
```

### 代码检查

```bash
npm.cmd run lint
```

### TypeScript 检查

```bash
npx.cmd tsc --noEmit
```

### 生产构建

```bash
npm.cmd run build
```

### 预览生产构建

```bash
npm.cmd run preview
```

## 常见问题

### 页面没有数据怎么办

1. 确认开发服务正在运行
2. 打开浏览器控制台查看是否有红色报错
3. 尝试切换数据源：Gate / Binance / OKX
4. 按 Ctrl + F5 强制刷新缓存
5. 检查本机网络是否能访问交易所公开接口

### 为什么不需要 API Key

当前项目是纯公开行情策略信号网站，只读取公开 K 线和实时行情，不读取账户、不查询持仓、不下单，因此不需要 API Key。

### 会自动下单吗

不会。当前版本只生成策略信号、止损止盈和风险提示，不执行任何交易。

## Git 使用说明

项目已经初始化为 Git 仓库，便于后续更新和回滚。

### 查看当前修改

```bash
git --no-pager status
```

### 查看具体差异

```bash
git --no-pager diff
```

### 添加文件到暂存区

```bash
git add .
```

### 创建提交

```bash
git commit -m "初始化 ETH SIGNAL 策略信号网站"
```

### 查看提交历史

```bash
git --no-pager log --oneline --decorate -10
```

### 回滚未提交的单个文件

```bash
git checkout -- src/components/SignalsView.tsx
```

### 回滚所有未提交修改

```bash
git reset --hard
```

### 回退到上一个提交

```bash
git reset --hard HEAD~1
```

### 创建功能分支

```bash
git checkout -b feature/new-strategy
```

## 推荐开发流程

每次修改前先确认状态：

```bash
git --no-pager status
```

修改后先检查：

```bash
npm.cmd run lint
npx.cmd tsc --noEmit
npm.cmd run build
```

确认没有问题后提交：

```bash
git add .
git commit -m "说明本次修改内容"
```

## 风险提示

- 本项目输出的信号仅供学习、研究和辅助判断
- 加密货币永续合约波动较大，任何策略都可能失效
- 不建议直接按照信号重仓交易
- 如果未来接入真实下单，需要单独增加权限隔离、风控、日志和人工确认机制
