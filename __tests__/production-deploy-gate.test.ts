/**
 * Issue #141 — production-worker.yml had no Lint/Typecheck gate while staging.yml did, so
 * production was the LESS verified path. A real defect class (~80 TS2339 errors) reached
 * production via `main` and was only caught on the way to staging.
 *
 * These tests pin the gate in place, and — just as importantly — pin the two things that must
 * NOT regress while it is there:
 *
 *   1. The `refs/heads/main` guard on the deploy job. It is deliberate and predates the gate.
 *   2. The absence of production database credentials from the verification job. staging.yml's
 *      "Unit and schema tests" step passes the UNPREFIXED SUPABASE_* secrets, which in this repo
 *      are the PRODUCTION ones (production-worker.yml's migration-drift step uses the same names
 *      against the production DB). Those tests are live-data assertions, not unit tests. Copying
 *      that step into the production workflow would point a test suite at the production
 *      database on every deploy. The production gate therefore runs only hermetic tests.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { parse } from 'yaml'

const WORKFLOWS = join(__dirname, '..', '.github', 'workflows')

type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string> }
type Job = { name?: string; needs?: string | string[]; if?: string; steps?: Step[] }
type Workflow = { jobs: Record<string, Job> } & Record<string, unknown>

function loadWorkflow(file: string): Workflow {
  return parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as Workflow
}

function stepsOf(job: Job | undefined): Step[] {
  return job?.steps ?? []
}

function findStep(job: Job | undefined, fragment: string): Step | undefined {
  return stepsOf(job).find((s) => (s.name ?? '').toLowerCase().includes(fragment.toLowerCase()))
}

describe('production deploy gate (#141)', () => {
  describe('both workflows are parseable YAML', () => {
    it.each(['production-worker.yml', 'staging.yml'])('%s parses', (file) => {
      const wf = loadWorkflow(file)
      expect(wf).toBeTruthy()
      expect(wf.jobs).toBeTruthy()
    })
  })

  describe('production-worker.yml has a verification gate', () => {
    it('defines a build-verification job', () => {
      const wf = loadWorkflow('production-worker.yml')
      expect(Object.keys(wf.jobs)).toContain('build-verification')
    })

    it('runs Lint and Typecheck in that job', () => {
      const wf = loadWorkflow('production-worker.yml')
      const gate = wf.jobs['build-verification']

      const lint = findStep(gate, 'lint')
      const typecheck = findStep(gate, 'typecheck')

      expect(lint?.run).toContain('eslint')
      expect(typecheck?.run).toContain('tsc --noEmit')
    })

    it('runs unit tests in that job', () => {
      const wf = loadWorkflow('production-worker.yml')
      const unit = findStep(wf.jobs['build-verification'], 'unit test')
      expect(unit?.run).toContain('jest')
    })

    it('makes deploy depend on build-verification', () => {
      const wf = loadWorkflow('production-worker.yml')
      const needs = wf.jobs['deploy']?.needs
      const asArray = Array.isArray(needs) ? needs : [needs]
      expect(asArray).toContain('build-verification')
    })
  })

  /**
   * A `needs:` dependency on a job that is SKIPPED (via the emergency override) skips the
   * dependent job too, unless its `if:` says otherwise. Without this, setting the override
   * would silently deploy nothing rather than deploying without verification.
   */
  it('deploy still runs when verification is deliberately skipped', () => {
    const wf = loadWorkflow('production-worker.yml')
    const deployIf = wf.jobs['deploy']?.if ?? ''
    expect(deployIf).toContain('needs.build-verification.result')
    expect(deployIf).toContain("'skipped'")
    expect(deployIf).toContain("'success'")
  })

  /**
   * Regression guard. This step predates #141 and is the only thing stopping a production
   * deploy from a non-main ref. Adding a gate above it must not displace it.
   */
  it('preserves the refs/heads/main guard on the deploy job', () => {
    const wf = loadWorkflow('production-worker.yml')
    const guard = findStep(wf.jobs['deploy'], 'Require main branch ref')

    expect(guard).toBeDefined()
    expect(guard?.run).toContain('refs/heads/main')
    expect(guard?.run).toContain('exit 1')
  })

  /**
   * The gate must not become a way for production credentials to reach a test runner.
   */
  it('does not wire any database secret into the production verification job', () => {
    const wf = loadWorkflow('production-worker.yml')
    const gate = wf.jobs['build-verification']

    for (const step of stepsOf(gate)) {
      const env = JSON.stringify(step.env ?? {})
      expect(env).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
      expect(env).not.toContain('SUPABASE_URL')
    }
  })

  /**
   * #142: conflict markers sat in a JSDoc block for days because neither the build nor
   * typecheck could see them. The issue asks for this in BOTH workflows.
   */
  describe('committed conflict markers are rejected', () => {
    it.each([
      ['production-worker.yml', 'build-verification'],
      ['staging.yml', 'build-verification'],
    ])('%s / %s checks for conflict markers', (file, jobName) => {
      const wf = loadWorkflow(file)
      const step = findStep(wf.jobs[jobName], 'conflict marker')

      expect(step).toBeDefined()
      expect(step?.run).toContain('<<<<<<<')
      expect(step?.run).toContain('exit 1')
    })
  })
})

/**
 * THE GATE ADDED 2026-08-24, and it is asserted here so it cannot be quietly removed.
 *
 * On that date twelve staging deploys shipped over a red E2E that named the exact live defect, on
 * the exact commit that caused it, and the code was then promoted to production. The signal existed
 * for two days and nothing consumed it. A check nobody is forced to read is not a gate.
 *
 * It lives on PRODUCTION rather than on the staging deploy because staging's verify job drives the
 * deployed worker — it cannot gate the deploy it verifies without being circular.
 */
describe('production refuses to promote from a red staging', () => {
  it('has a staging-health job', () => {
    const wf = loadWorkflow('production-worker.yml')
    expect(Object.keys(wf.jobs)).toContain('staging-health')
  })

  it('and the deploy actually depends on it', () => {
    // The job existing proves nothing if nothing waits for it.
    const wf = loadWorkflow('production-worker.yml')
    const needs = wf.jobs['deploy']?.needs
    const asArray = Array.isArray(needs) ? needs : [needs]
    expect(asArray).toContain('staging-health')
  })

  it('the deploy condition consults its result, not just its existence', () => {
    const wf = loadWorkflow('production-worker.yml')
    expect(String(wf.jobs['deploy']?.if ?? '')).toContain('needs.staging-health.result')
  })

  it('the emergency override still reaches production, and is recorded', () => {
    // A gate with no override becomes the thing someone disables. This one skips with
    // skip_verification, which the run log records.
    const wf = loadWorkflow('production-worker.yml')
    expect(String(wf.jobs['staging-health']?.if ?? '')).toContain('skip_verification')
    expect(String(wf.jobs['deploy']?.if ?? '')).toContain("needs.staging-health.result == 'skipped'")
  })
})

/**
 * A GATE THAT RUNS NOWHERE — found 2026-08-27 auditing every `scripts/check-*`.
 *
 * `scripts/check-orders-fixture-excluded.ts` was written as a blocking gate (6e1195d8, #324) and
 * added to no workflow. It ran nowhere for its entire life, and THREE separate documents said
 * otherwise: its own docblock ("Static ... Blocking in CI"), and a COMMENT ON in
 * supabase/migrations/20260827116000_orders_is_stress_fixture.sql -- deployed to the database --
 * reading "CI enforces it via scripts/check-orders-fixture-excluded.ts".
 *
 * The gate itself is sound: it self-tests its detectors, and it goes RED naming the offending line
 * on an unscoped `count: 'exact'` over `orders`. Nothing was wrong with it except that no CI step
 * named it. That is the strongest form of decoration there is, and the documentation asserting it
 * ran made it worse rather than better -- an all-clear nobody thinks to question.
 *
 * So the wiring is now pinned. Grepping a YAML file for a script name is a weak test in general,
 * but the failure being guarded is exactly "the script exists and nothing invokes it", which is
 * the one thing such a test detects and the only thing it needs to.
 */
describe('every static orders gate is actually invoked by a workflow', () => {
  const GATES = ['scripts/check-orders-read-bounded.ts', 'scripts/check-orders-fixture-excluded.ts']

  const runsIn = (file: string): string[] =>
    Object.values(loadWorkflow(file).jobs).flatMap((j) => stepsOf(j).map((s) => s.run ?? ''))

  it.each(GATES)('production-worker.yml runs %s', (script) => {
    expect(runsIn('production-worker.yml').some((r) => r.includes(script))).toBe(true)
  })

  it.each(GATES)('staging.yml runs %s', (script) => {
    expect(runsIn('staging.yml').some((r) => r.includes(script))).toBe(true)
  })

  it('runs the fixture gate in a job the deploy actually waits for', () => {
    // CONTROL, and the half a grep would miss. A step in a job nothing `needs:` blocks nothing --
    // wired and still decorative, the same defect wearing a workflow step.
    const wf = loadWorkflow('production-worker.yml')
    const owning = Object.entries(wf.jobs).find(([, j]) =>
      stepsOf(j).some((s) => (s.run ?? '').includes('scripts/check-orders-fixture-excluded.ts')),
    )
    expect(owning).toBeDefined()
    const needs = wf.jobs['deploy']?.needs
    const asArray = Array.isArray(needs) ? needs : [needs]
    expect(asArray).toContain(owning![0])
  })

  it('does not let the fixture gate swallow its own exit code', () => {
    // `continue-on-error: true` is how the migration drift check in this same workflow became
    // decoration -- see the note in scripts/check-branch-drift.mjs. A gate that reports without
    // blocking is a report, and must not be mistaken for a gate.
    const wf = loadWorkflow('production-worker.yml')
    for (const job of Object.values(wf.jobs)) {
      for (const step of stepsOf(job)) {
        if ((step.run ?? '').includes('scripts/check-orders-fixture-excluded.ts')) {
          expect((step as { 'continue-on-error'?: boolean })['continue-on-error']).toBeFalsy()
          expect(step.run).not.toMatch(/\|\|\s*true|;\s*true|set \+e/)
        }
      }
    }
  })
})
