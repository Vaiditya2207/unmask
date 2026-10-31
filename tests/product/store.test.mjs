import assert from "node:assert/strict";
import { test } from "node:test";
import { createReportStore } from "../../src/server/store.mjs";

function stored(
  failures,
  { status = "incomplete", exitCode = 2, modelStatus = "disabled" } = {},
) {
  const store = createReportStore();
  store.put({
    id: "job",
    key: "fixture@1.0.0",
    status,
    report: {
      policy: { exitCode, findings: [] },
      model: { status: modelStatus },
      failures: failures.map((value) => ({
        message: "Fixture failure",
        ...value,
      })),
    },
  });
  return store.findKey("fixture@1.0.0");
}
const caps = [
  "compressed-cap",
  "expanded-cap",
  "ratio-cap",
  "entry-cap",
  "path-cap",
  "metadata-cap",
  "path-depth-cap",
  "path-node-cap",
];

test("the exact deterministic incomplete table reuses current archive caps and only manifest ambiguity", () => {
  for (const code of caps) assert.equal(stored([{ code }])?.id, "job", code);
  const ambiguous = {
    code: "source-selection-unresolved",
    reason: "ambiguous-manifest",
  };
  assert.equal(stored([ambiguous])?.id, "job");
  assert.equal(
    stored([...caps.map((code) => ({ code })), ambiguous])?.id,
    "job",
  );
});

test("unclassified caps, other source-selection reasons and transient failures never reuse", () => {
  for (const failure of [
    { code: "future-cap" },
    { code: "source-selection-unresolved" },
    { code: "source-selection-unresolved", reason: "manifest-not-found" },
    { code: "source-selection-unresolved", reason: "source-unavailable" },
    { code: "source-selection-unresolved", reason: "AMBIGUOUS-MANIFEST" },
    {
      code: "source-selection-unresolved",
      reason: { value: "ambiguous-manifest" },
    },
    { code: "source-acquisition-failed" },
    { code: "analysis-timeout" },
    { code: "execution-timeout" },
    { code: "queue-expired" },
    { code: "parse-timeout" },
  ]) {
    assert.equal(stored([failure]), undefined, JSON.stringify(failure));
    assert.equal(
      stored([{ code: "path-depth-cap" }, failure]),
      undefined,
      JSON.stringify(failure),
    );
    assert.equal(
      stored([
        { code: "source-selection-unresolved", reason: "ambiguous-manifest" },
        failure,
      ]),
      undefined,
      JSON.stringify(failure),
    );
  }
  assert.equal(stored([]), undefined);
});

test("transient model states and non-incomplete exit-2 records cannot reuse deterministic failures", () => {
  const failures = [
    { code: "path-node-cap" },
    { code: "source-selection-unresolved", reason: "ambiguous-manifest" },
  ];
  for (const modelStatus of [
    "unavailable",
    "timeout",
    "failed",
    "invalid",
    "quota-exceeded",
  ])
    assert.equal(stored(failures, { modelStatus }), undefined, modelStatus);
  for (const status of ["failed", "queued", "running", "done"])
    assert.equal(stored(failures, { status }), undefined, status);
  for (const exitCode of [0, 1, 3])
    assert.equal(stored(failures, { exitCode }), undefined, String(exitCode));
});
