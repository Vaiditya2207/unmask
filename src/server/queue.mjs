import { randomBytes } from "node:crypto";
import {
  boundedVulnerabilityCheck,
  unavailableVulnerabilityCheck,
} from "./enrichment.mjs";

export const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: 4096,
  bodyTimeoutMs: 10000,
  queueTtlMs: 300000,
  executionMs: 240000,
  maxNewChecks: 6,
  admissionWindowMs: 600000,
  maxReportBytes: 64 * 1024 * 1024,
  maxReports: 200,
  reportTtlMs: 1800000,
});
export const systemClock = { now: Date.now, setTimeout, clearTimeout };

export function resolveLimits(overrides = {}) {
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !(key in DEFAULT_LIMITS) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > DEFAULT_LIMITS[key]
    )
      throw new TypeError(`Invalid limit: ${key}`);
  }
  return { ...DEFAULT_LIMITS, ...overrides };
}

export function createQueue({
  runAnalysis,
  enrichJob,
  store,
  limits,
  clock = systemClock,
  keyPrefix = "",
}) {
  let active,
    waiting,
    closed = false;
  let admissions = [];
  function persist(job) {
    if (!store.put(job)) {
      if (
        job.report &&
        job.vulnerabilityCheck &&
        store.put({
          ...job,
          vulnerabilityCheck: unavailableVulnerabilityCheck(
            job.nameAtExactVersion,
            clock,
            "storage-byte-cap",
          ),
        })
      )
        return;
      const { report, vulnerabilityCheck, ...small } = job;
      store.put({ ...small, status: "incomplete", reason: "report-too-large" });
    }
  }
  function expireWaiting(job) {
    if (waiting !== job) return;
    waiting = undefined;
    job.status = "incomplete";
    job.reason = "queue-expired";
    job.finishedAt = clock.now();
    clock.clearTimeout(job.queueTimer);
    delete job.queueTimer;
    persist(job);
  }
  function begin(job) {
    active = job;
    waiting = undefined;
    if (job.queueTimer !== undefined) clock.clearTimeout(job.queueTimer);
    delete job.queueTimer;
    job.status = "running";
    job.startedAt = clock.now();
    const controller = new AbortController();
    let coreReport;
    const timer = clock.setTimeout(() => {
      job.finishedAt = clock.now();
      if (coreReport) {
        job.status = coreReport.policy.exitCode === 2 ? "incomplete" : "done";
        persist({
          ...publicJob(job),
          report: coreReport,
          vulnerabilityCheck: unavailableVulnerabilityCheck(
            job.nameAtExactVersion,
            clock,
            "aborted",
          ),
        });
      } else {
        job.status = "incomplete";
        job.reason = "execution-timeout";
        persist(job);
      }
      controller.abort();
    }, limits.executionMs);
    timer?.unref?.();
    job.cancel = () => {
      clock.clearTimeout(timer);
      controller.abort();
    };
    Promise.resolve()
      .then(() =>
        runAnalysis(job.nameAtExactVersion, { signal: controller.signal }),
      )
      .then(async (report) => {
        if (job.status !== "running" || closed) return;
        if (
          !report ||
          typeof report !== "object" ||
          Array.isArray(report) ||
          ![0, 2, 3].includes(report.policy?.exitCode)
        )
          throw new TypeError("Invalid report");
        coreReport = report;
        let vulnerabilityCheck;
        if (enrichJob) {
          let abort;
          const interrupted = new Promise((resolve) => {
            abort = () =>
              resolve(
                unavailableVulnerabilityCheck(
                  job.nameAtExactVersion,
                  clock,
                  "aborted",
                ),
              );
            controller.signal.addEventListener("abort", abort, { once: true });
            if (controller.signal.aborted) abort();
          });
          try {
            const value = await Promise.race([
              Promise.resolve().then(() =>
                enrichJob(job.nameAtExactVersion, {
                  signal: controller.signal,
                }),
              ),
              interrupted,
            ]);
            vulnerabilityCheck = boundedVulnerabilityCheck(
              value,
              job.nameAtExactVersion,
              clock,
            );
          } catch {
            vulnerabilityCheck = unavailableVulnerabilityCheck(
              job.nameAtExactVersion,
              clock,
              "lookup-failed",
            );
          } finally {
            controller.signal.removeEventListener("abort", abort);
          }
        }
        if (job.status !== "running" || closed) return;
        const status = report.policy.exitCode === 2 ? "incomplete" : "done";
        const finishedAt = clock.now();
        persist({
          ...publicJob(job),
          status,
          report,
          finishedAt,
          ...(vulnerabilityCheck ? { vulnerabilityCheck } : {}),
        });
        job.status = status;
        job.finishedAt = finishedAt;
      })
      .catch(() => {
        if (job.status !== "running" || closed) return;
        job.status = "failed";
        job.reason = "analysis-failed";
        job.finishedAt = clock.now();
        delete job.report;
        persist(publicJob(job));
      })
      .finally(() => {
        clock.clearTimeout(timer);
        active = undefined;
        if (waiting && !closed) {
          if (clock.now() - waiting.createdAt >= limits.queueTtlMs)
            expireWaiting(waiting);
          else begin(waiting);
        }
      });
  }
  function publicJob(job) {
    const { cancel, queueTimer, report, ...metadata } = job;
    return report ? { ...metadata, report } : metadata;
  }
  return {
    submit(nameAtExactVersion) {
      const key = `${keyPrefix}\n${nameAtExactVersion}`;
      const existing =
        [active, waiting].find(
          (job) =>
            job?.key === key && ["queued", "running"].includes(job.status),
        ) || store.findKey(key);
      if (existing) return { job: publicJob(existing), reused: true };
      admissions = admissions.filter(
        (time) => clock.now() - time < limits.admissionWindowMs,
      );
      if (
        closed ||
        (active && waiting) ||
        admissions.length >= limits.maxNewChecks
      )
        return {
          retryAfter: Math.max(
            1,
            Math.ceil(
              (admissions.length >= limits.maxNewChecks
                ? admissions[0] + limits.admissionWindowMs - clock.now()
                : limits.executionMs) / 1000,
            ),
          ),
        };
      const job = {
        id: randomBytes(16).toString("hex"),
        key,
        nameAtExactVersion,
        status: "queued",
        createdAt: clock.now(),
      };
      admissions.push(clock.now());
      if (!active) begin(job);
      else {
        waiting = job;
        job.queueTimer = clock.setTimeout(
          () => expireWaiting(job),
          limits.queueTtlMs,
        );
      }
      return { job: publicJob(job), reused: false };
    },
    get(id) {
      const job = [active, waiting].find((item) => item?.id === id);
      return job && ["queued", "running"].includes(job.status)
        ? publicJob(job)
        : store.get(id);
    },
    close() {
      closed = true;
      if (waiting) {
        clock.clearTimeout(waiting.queueTimer);
        waiting = undefined;
      }
      active?.cancel();
    },
  };
}
