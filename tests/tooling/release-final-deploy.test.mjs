import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const job = (name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, `missing job ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

test("repository declares an explicit final-release selection", () => {
  const config = JSON.parse(
    readFileSync(new URL("../../release.config.json", import.meta.url), "utf8"),
  );
  assert.ok(Object.hasOwn(config, "productionDeployVersion"));
  assert.ok(
    config.productionDeployVersion === null ||
      (typeof config.productionDeployVersion === "string" &&
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
          config.productionDeployVersion,
        )),
  );
});

test("readiness exports the final-release deploy decision", () => {
  assert.match(
    job("readiness"),
    /production_deploy: \$\{\{ steps\.gate\.outputs\.production_deploy \}\}/,
  );
  assert.match(job("readiness"), /--github-output --version-candidate/);
});

test("API and web production deploys both require the explicit final-release gate", () => {
  for (const name of ["deploy", "deploy-web"]) {
    const block = job(name);
    assert.match(block, /needs: \[readiness, publish/);
    assert.match(
      block,
      /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && needs\.readiness\.outputs\.production_deploy == 'true' && needs\.publish\.outputs\.complete == 'true' && needs\.publish\.outputs\.npm_published == 'true'/,
    );
    assert.match(block, /name: production/);
    assert.doesNotMatch(block, /workflow_dispatch|inputs\./);
  }
  assert.match(job("deploy-web"), /needs\.deploy\.result == 'success'/);
  assert.doesNotMatch(workflow, /^\s+workflow_dispatch:/m);
});

test("build, smoke, npm and immutable GitHub release continue without the deploy gate", () => {
  const publish = job("publish");
  const [jobHeader] = publish.split("\n    steps:\n");
  assert.doesNotMatch(jobHeader, /production_deploy/);
  for (const step of [
    "id: plan",
    "id: image",
    "id: smoke",
    "id: npm",
    "id: release",
  ])
    assert.ok(publish.includes(step), step);
  const npmStep = publish.slice(
    publish.indexOf("id: npm"),
    publish.indexOf("id: release"),
  );
  assert.doesNotMatch(npmStep, /production_deploy/);
  assert.match(
    publish.slice(publish.indexOf("id: release")),
    /PRODUCTION_DEPLOY: \$\{\{ needs\.readiness\.outputs\.production_deploy \}\}/,
  );
});

test("the release body states whether production deployment is scheduled", () => {
  const release = readFileSync(
    new URL("../../scripts/release.mjs", import.meta.url),
    "utf8",
  );
  assert.match(release, /process\.env\.PRODUCTION_DEPLOY === "true"/);
  assert.match(
    release,
    /Production deployment deferred: API and web production were not changed/,
  );
});
