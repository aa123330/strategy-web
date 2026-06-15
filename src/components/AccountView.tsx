import { useState } from "react";
import { useAccountStore, useMarketStore, useStrategyStore, useOrderStore, useCredentialsStore } from "../store";
import { buildDecision, calcContractSize } from "../strategies/signalProcessor";
import { createOrder } from "../services/gatePrivateApi";
import { AlertCircle, CheckCircle, XCircle, ShieldCheck, RefreshCw } from "lucide-react";

export default function AccountView() {
  const { account, position, setAccount, setPosition } = useAccountStore();
  const { contract } = useMarketStore();
  const { signal } = useStrategyStore();
  const { key, secret } = useCredentialsStore();
  const { preview, decisionReason, orderResult, submitting, submitError, success, openUsdt, setOpenUsdt, setPreview, setSubmitting, setSubmitResult, clearResult } = useOrderStore();
  const [confirming, setConfirming] = useState(false);

  const posSize = position?.size ?? 0;
  const markPrice = contract ? Number(contract.mark_price) : 0;
  const multiplier = contract ? Number(contract.quanto_multiplier) : 0.01;

  const handlePreview = () => {
    if (!signal) return;
    const decision = buildDecision(signal, position ?? null, "ETH_USDT");
    if (decision.action === "open_long" || decision.action === "open_short") {
      const size = calcContractSize(markPrice, multiplier, openUsdt);
      const side = decision.action === "open_long" ? 1 : -1;
      setPreview({
        contract: "ETH_USDT",
        size: String(size * side),
        price: "0",
        tif: "ioc",
        reduce_only: false,
        text: "t-gatebot-web-open",
      }, decision.reason);
    } else if (decision.order) {
      setPreview(decision.order, decision.reason);
    } else {
      setPreview(null, decision.reason);
    }
  };

  const handleSubmit = async () => {
    if (!preview || !key || !secret) return;
    setConfirming(true);
    clearResult();
    setSubmitting(true);
    try {
      const result = await createOrder(key, secret, preview);
      setSubmitResult(result, null);
      // 刷新账户
      const { getFuturesAccount, getPosition } = await import("../services/gatePrivateApi");
      const [acc, pos] = await Promise.all([getFuturesAccount(key, secret), getPosition(key, secret)]);
      setAccount(acc);
      setPosition(pos);
    } catch (e) {
      setSubmitResult(null, e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* 账户快照 */}
      <div style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
        <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "12px", display: "flex", alignItems: "center", gap: "6px" }}>
          <ShieldCheck size={12} style={{ color: "var(--color-long)" }} />Gate 测试网 · 仅支持模拟盘
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: "16px" }}>
          <DataItem label="账户权益" value={account ? `$${Number(account.total).toFixed(4)}` : "—"} />
          <DataItem label="当前仓位" value={posSize === 0 ? "无持仓" : posSize > 0 ? `做多 ${posSize} 张` : `做空 ${Math.abs(posSize)} 张`} color={posSize > 0 ? "var(--color-long)" : posSize < 0 ? "var(--color-short)" : undefined} />
          <DataItem label="杠杆" value={position?.leverage ? `${position.leverage}x` : "—"} />
          <DataItem label="强平价" value={position?.liq_price ? `$${Number(position.liq_price).toFixed(2)}` : "—"} color={position?.liq_price ? "var(--color-warning)" : undefined} />
          <DataItem label="标记价格" value={markPrice ? `$${markPrice.toFixed(2)}` : "—"} />
          <DataItem label="合约乘数" value={multiplier ? `${multiplier}` : "—"} />
        </div>
      </div>

      {/* 开仓金额 */}
      <div style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
        <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "12px" }}>开仓金额（USDT）</div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <input
            type="number"
            value={openUsdt}
            onChange={(e) => setOpenUsdt(Math.max(1, Number(e.target.value)))}
            min={1}
            max={1000}
            style={{ width: "120px" }}
          />
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>USDT</span>
          <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}>
            ≈ {calcContractSize(markPrice, multiplier, openUsdt)} 张
          </span>
        </div>
      </div>

      {/* 订单预览 */}
      <div style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>订单预览</div>
          <button onClick={handlePreview} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: "12px" }} disabled={!signal}>
            <RefreshCw size={11} /> 生成预览
          </button>
        </div>

        {decisionReason && (
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px", padding: "8px 10px", backgroundColor: "var(--color-bg-base)", borderRadius: "6px" }}>
            {decisionReason}
          </div>
        )}

        {preview ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "8px" }}>
            {[
              ["合约", preview.contract],
              ["方向", (preview.size.startsWith("-") ? "做空" : "做多")],
              ["张数", preview.size],
              ["价格", preview.price === "0" ? "市价" : `$${preview.price}`],
              ["有效期", preview.tif.toUpperCase()],
              ["reduce_only", String(preview.reduce_only)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px", backgroundColor: "var(--color-bg-base)", borderRadius: "5px" }}>
                <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{k}</span>
                <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--color-text-primary)", fontWeight: 500 }}>{v}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: "20px", color: "var(--color-text-secondary)", fontSize: "13px" }}>
            点击「生成预览」查看订单详情
          </div>
        )}
      </div>

      {/* 结果展示 */}
      {success && orderResult !== null && orderResult !== undefined && (
        <div style={{ backgroundColor: "rgba(0,200,83,0.08)", border: "1px solid rgba(0,200,83,0.3)", borderRadius: "10px", padding: "14px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <CheckCircle size={16} style={{ color: "var(--color-btn-success)", flexShrink: 0, marginTop: "1px" }} />
          <div>
            <div style={{ fontSize: "13px", fontWeight: 500, color: "var(--color-btn-success)" }}>订单已提交成功</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px", fontFamily: "var(--font-mono)" }}>
              {JSON.stringify(orderResult, null, 2)}
            </div>
          </div>
        </div>
      )}

      {submitError && (
        <div style={{ backgroundColor: "rgba(255,51,102,0.08)", border: "1px solid rgba(255,51,102,0.3)", borderRadius: "10px", padding: "14px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <XCircle size={16} style={{ color: "var(--color-short)", flexShrink: 0, marginTop: "1px" }} />
          <div>
            <div style={{ fontSize: "13px", fontWeight: 500, color: "var(--color-short)" }}>下单失败</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>{submitError}</div>
          </div>
        </div>
      )}

      {/* 确认下单 */}
      {!key || !secret ? (
        <div style={{ backgroundColor: "rgba(255,152,0,0.08)", border: "1px solid rgba(255,152,0,0.3)", borderRadius: "10px", padding: "14px", display: "flex", gap: "10px", alignItems: "center" }}>
          <AlertCircle size={16} style={{ color: "var(--color-warning)", flexShrink: 0 }} />
          <span style={{ fontSize: "13px", color: "var(--color-warning)" }}>请先在顶部连接 Gate 测试网 API</span>
        </div>
      ) : preview && !success ? (
        <button
          onClick={handleSubmit}
          disabled={submitting || confirming}
          className="btn btn-success"
          style={{ width: "100%", padding: "12px", fontSize: "15px" }}
        >
          <ShieldCheck size={16} />
          {submitting ? "提交中..." : "确认下单（Gate 测试网）"}
        </button>
      ) : null}
    </div>
  );
}

function DataItem({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: "10px", color: "var(--color-text-secondary)", marginBottom: "3px" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "14px", color: color || "var(--color-text-primary)", fontWeight: 500 }}>
        {value}
      </div>
    </div>
  );
}
