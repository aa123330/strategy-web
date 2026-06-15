export interface CandleRow {
  time: number;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  is_ascending: boolean;
  turnover: string;
}

export interface Contract {
  name: string;
  type: string;
  quanto: boolean;
  inverse: boolean;
  settle_currency: string;
  trade_price_symbol: string;
  funding_rate: string;
  funding_rate_next: string;
  indicative_funding_rate: string;
  mark_price_round: string;
  settlments: string[];
  leverage_min: string;
  leverage_max: string;
  maintenance_rate: string;
  mark_type: string;
  rounding_state: string;
  trade_size: string;
  trade_size_min: string;
  trade_size_max: string;
  price_precision: number;
  internal_precision: string;
  settle_price_precision: string;
  order_price_round: string;
  order_price_precision: string;
  index_price_precision: string;
  leverage_step: string;
  price_CCY: string;
  mark_price: string;
  quanto_multiplier: string;
}

export async function getContract(contract = "ETH_USDT"): Promise<Contract | null> {
  const resp = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${contract}`);
  if (!resp.ok) return null;
  return (await resp.json()) as Contract;
}
