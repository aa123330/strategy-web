import { backfillGateCandles } from "./collectors/gateCollector";
import { backfillOkxCandles } from "./collectors/okxCollector";
import type { Interval } from "./types";

export type BackfillJobStatus = "running" | "completed" | "failed";

export interface BackfillJob {
  id: string;
  exchange: "gate" | "okx";
  symbols: string[];
  intervals: Interval[];
  days: number;
  status: BackfillJobStatus;
  inserted: number;
  messages: string[];
  currentMessage: string;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

const jobs = new Map<string, BackfillJob>();

function makeJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pushMessage(job: BackfillJob, message: string) {
  job.currentMessage = message;
  job.messages = [...job.messages, message].slice(-80);
}

export function createBackfillJob(params: {
  exchange: "gate" | "okx";
  symbols: string[];
  intervals: Interval[];
  days: number;
}) {
  const job: BackfillJob = {
    id: makeJobId(),
    exchange: params.exchange,
    symbols: params.symbols,
    intervals: params.intervals,
    days: params.days,
    status: "running",
    inserted: 0,
    messages: [],
    currentMessage: "准备开始补充历史数据",
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);

  void runJob(job);
  return job;
}

async function runJob(job: BackfillJob) {
  try {
    const onProgress = (message: string) => pushMessage(job, message);
    const result = job.exchange === "okx"
      ? await backfillOkxCandles({ symbols: job.symbols, intervals: job.intervals, days: job.days, onProgress })
      : await backfillGateCandles({ symbols: job.symbols, intervals: job.intervals, days: job.days, onProgress });
    job.inserted = result.inserted;
    job.status = "completed";
    job.finishedAt = Date.now();
    pushMessage(job, `完成，${job.exchange} 写入/更新 ${result.inserted} 根K线`);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = Date.now();
    pushMessage(job, `失败：${job.error}`);
  }
}

export function getBackfillJob(id: string) {
  return jobs.get(id) ?? null;
}
