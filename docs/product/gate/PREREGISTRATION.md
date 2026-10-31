# UNMASK model usefulness gate: pre-registration

Frozen by UNMASK PM before any model output. Revision 2 updates the route, caps and pacing only, before any output. Revision 3 adds the output-cap and prompt-iteration disclosure, before any output. This file only plans the run; no provider call has been made.

- Labels: the frozen dev triage labels v2.1, `../../fixtures/labels/triage-labels.dev.v2.1.json`, sha256 `fd6ac97b52277bc6185a081f57c256e0ecfba98526518421059f177d920d16da`.
- Scoring rules: `../../fixtures/labels/SCORING_RULES.v19.txt`, sha256 `d03ac96459fea2adcf64d281b52894e43e57f1e3d99483fb2b658288d4b7454f`.
- Commitments: `../../fixtures/labels/COMMITMENTS.json`, sha256 `5b32aae385cd6ffc804b960b6f0763be529f1ac899ed6e98dc9c63e63efe0e71`.
- Holdouts stay sealed and are not run.
- **Five fixtures:** V1 (lifecycle injection, chalk), V4 (single-token logic edit, chalk), V5 (bundle mutation with the sourcemap unchanged, axios), V6 (inert encoded blob, axios), V7 (benign metadata, chalk).
  - The selection rule was fixed before any output: cover both base packages; include risk-positive cases of four distinct classes (manifest, logic, bundle, data); include at least one benign control.
  - V2, V3 and V8 are excluded from this five-fixture run and may be run later as a separately reported extension.
- **Entry point:** the normal installed CLI, offline local mode, with `--allow-model`. It uses the explicit source archive, the full commit, `--source-root` set to the archive prefix, and `--source-dir ''`, exactly as the deterministic matrix did.
- **Model config (updated before any output, after the user's route change, EM #92734):** the default three-tier route in the tested commit:
  1. `gemini-3.5-flash` / high
  2. `gemini-3-flash-preview` / minimal
  3. `gemma-4-26b-a4b-it` / minimal

  Limits: at most 3 generations within 135 s total. Settings are `UNMASK_MODEL=on` and `UNMASK_MODEL_QUOTA_VERIFIED=false`. Operator caps are 3 generations/min, 12,000 input TPM and 100/day; provider quotas are unknown. There is no `UNMASK_MODEL_ROUTE` override.
  - **Config disclosure, rev 3, before any gate output:** the output cap is 4,096 tokens on the Gemini tiers (deliberate, because high thinking consumes the output budget) and 1,000 on Gemma; JSON mode is Gemini-only. The prompt was revised twice (43450a9, 5a560e2) after observing live **non-fixture** zod output and before any gate run. The gate scores only the config whose promptHash and configHash are recorded in the reports (currently `82d2862a…` / `169f8b2b…`). Any further change means a new run, reported separately.
  - Results are reported per producing tier. Only hypotheses produced by the Gemma tier could be cited as open-weight evidence, and even those are not claimed as acceptance from this run alone.
- **No tuning:** no prompt, eligibility or label changes are allowed after any output. Any config change requires a new digest and a new run, reported separately.
- **Pacing:** at least 62 s between fixtures, so a fixture using all 3 generations still stays under the 3-generations-per-minute operator cap.
- **Reporting:**
  - per tier (the tier actually used for each attempt, never pooled)
  - B1 baseline scored on identical denominators
  - end-to-end recall: omissions count as misses, `unknown` is never a hit
  - risk-positive recall reported separately from all-label localization
  - V7 false alarms
  - unscorable spans listed

  Open-weight acceptance is separate, unmet, and not claimed. A primary-model (Gemini) result is not open-weight evidence.
- **Scorer:** written and hash-frozen by the independent Fixture QA agent before any output, under `fixtures/labels/`.
