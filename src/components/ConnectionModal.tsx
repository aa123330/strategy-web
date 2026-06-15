import { useState } from "react";
import { X, Key, Lock, AlertCircle } from "lucide-react";
import { useCredentialsStore } from "../store";
import { getFuturesAccount } from "../services/gatePrivateApi";

interface Props {
  onClose: () => void;
}

export default function ConnectionModal({ onClose }: Props) {
  const { setCredentials } = useCredentialsStore();
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    if (!key.trim() || !secret.trim()) {
      setError("请输入完整的 API Key 和 Secret");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // 验证凭证：尝试拉取账户
      const account = await getFuturesAccount(key.trim(), secret.trim());
      if (!account) {
        setError("无法连接 Gate 测试网，请检查 Key / Secret 是否正确");
        return;
      }
      setCredentials(key.trim(), secret.trim());
      onClose();
    } catch (e) {
      setError("连接失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleConnect();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          backgroundColor: "var(--color-bg-card)",
          border: "1px solid var(--color-border)",
          borderRadius: "12px",
          padding: "28px",
          width: "420px",
          maxWidth: "90vw",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Key size={18} style={{ color: "var(--color-long)" }} />
            <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "var(--color-text-primary)" }}>
              连接 Gate 测试网
            </h2>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: "4px" }}>
            <X size={18} />
          </button>
        </div>

        {/* Notice */}
        <div style={{ backgroundColor: "var(--color-bg-base)", border: "1px solid var(--color-border)", borderRadius: "8px", padding: "12px 14px", marginBottom: "20px", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: "1.6" }}>
          <div style={{ display: "flex", gap: "6px", alignItems: "flex-start" }}>
            <Lock size={12} style={{ marginTop: "2px", flexShrink: 0, color: "var(--color-long)" }} />
            <span>API Key / Secret 仅存储在浏览器 sessionStorage 中，关闭标签页后自动清除，不会发送至任何第三方。</span>
          </div>
        </div>

        {/* Inputs */}
        <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginBottom: "20px" }}>
          <div>
            <label style={{ display: "block", fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "6px" }}>
              API Key
            </label>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="请输入 Gate API Key"
              style={{ width: "100%", boxSizing: "border-box" }}
              autoFocus
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "6px" }}>
              API Secret
            </label>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="请输入 Gate API Secret"
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{ display: "flex", gap: "8px", alignItems: "center", color: "var(--color-short)", fontSize: "13px", marginBottom: "16px" }}>
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: "10px" }}>
          <button onClick={onClose} className="btn btn-ghost" style={{ flex: 1 }}>
            取消
          </button>
          <button onClick={handleConnect} className="btn btn-success" style={{ flex: 2 }} disabled={loading}>
            {loading ? "连接中..." : "连接 Gate 测试网"}
          </button>
        </div>
      </div>
    </div>
  );
}
