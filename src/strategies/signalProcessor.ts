import type { StrategySignal } from "./dualMa";
import type { Position } from "../services/gatePrivateApi";

export interface OrderDraft {
  contract: string;
  size: string;
  price: string;
  tif: "ioc" | "gtc" | "poc";
  reduce_only: boolean;
  text?: string;
}

export interface Decision {
  action: "open_long" | "open_short" | "close_long" | "close_short" | "hold";
  order?: OrderDraft;
  reason: string;
}

export function calcContractSize(markPrice: number, multiplier: number, openUsdt: number): number {
  if (!markPrice || !multiplier) return 0;
  return Math.floor((openUsdt * multiplier) / markPrice);
}

export function buildDecision(
  signal: StrategySignal,
  position: Position | null,
  symbol: string
): Decision {
  const size = 0;
  const tif = "ioc" as const;

  switch (signal.action) {
    case "OPEN_LONG":
      return {
        action: "open_long",
        order: {
          contract: symbol,
          size: String(size),
          price: "0",
          tif,
          reduce_only: false,
          text: "t-gatebot-web-open",
        },
        reason: signal.reason,
      };
    case "OPEN_SHORT":
      return {
        action: "open_short",
        order: {
          contract: symbol,
          size: String(-size),
          price: "0",
          tif,
          reduce_only: false,
          text: "t-gatebot-web-open",
        },
        reason: signal.reason,
      };
    case "CLOSE_LONG":
      if (position && position.size > 0) {
        return {
          action: "close_long",
          order: {
            contract: symbol,
            size: String(-position.size),
            price: "0",
            tif,
            reduce_only: true,
            text: "t-gatebot-web-close",
          },
          reason: signal.reason,
        };
      }
      return { action: "hold", reason: "无多仓需要平" };
    case "CLOSE_SHORT":
      if (position && position.size < 0) {
        return {
          action: "close_short",
          order: {
            contract: symbol,
            size: String(Math.abs(position.size)),
            price: "0",
            tif,
            reduce_only: true,
            text: "t-gatebot-web-close",
          },
          reason: signal.reason,
        };
      }
      return { action: "hold", reason: "无空仓需要平" };
    case "HOLD":
    default:
      return { action: "hold", reason: signal.reason };
  }
}