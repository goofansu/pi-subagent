/**
 * The demo backend set: the composition root for M3.
 *
 * This is the only file under `host/` that may name a backend or a fake, and
 * the boundary test enforces that. Everything else in the host reaches
 * backends through the runtime, which is what stops two things owning
 * BackendAgent lifetime.
 *
 * The set exists so that launching Pi with only the v2 entry point gives a
 * *working* extension with nothing to configure: two backends, one Profile per
 * backend, and a script that answers. Without it, M3 would prove the host
 * boundary against a Session with no backends and no Profiles, which is the
 * one shape a user never has.
 *
 * The fakes therefore stop being test-only for this milestone, and the way
 * they stop is deliberately narrow. The script vocabulary, the resource
 * counters, and the rigs stay where they are, in the test tree, and this file
 * is the only production module that reaches any of it. M4 replaces this set
 * with one containing the real Pi backend, and the demo Profiles go with it.
 *
 * The script is one Run's worth of behaviour, chosen so that every product
 * surface has something to show: it reports an activity so a widget row has a
 * tail, echoes the brief it was given so `agent_result` returns something the
 * user can recognize as an answer to their own question, and reports a small
 * usage delta so the notification has an accounting line. It is deterministic
 * by construction — no gate, no sleep, no randomness — which is what lets a
 * host test assert on the text a user would see.
 */

import {
  answeredEnding,
  backendId,
  DEFAULT_BACKEND_ID,
  type Profile,
} from "../domain/index.ts";
import type { BackendSet } from "../runtime/composition.ts";
import {
  createFakeOneShotBackend,
  createFakeResumableBackend,
} from "../testing/fakes/backend.ts";
import {
  emitActivity,
  type FakeStep,
  scripts,
} from "../testing/fakes/script.ts";

/** What the demo set is called, for the start-up diagnostic. */
export const DEMO_BACKEND_SET_NAME = "demo";

/** The two demo Profile names, one per fake. */
export const DEMO_RESUMABLE_PROFILE = "demo-resumable";
export const DEMO_ONE_SHOT_PROFILE = "demo-one-shot";

/** The backend id the one-shot demo Profile names. */
export const DEMO_ONE_SHOT_BACKEND = backendId("demo-one-shot");

/**
 * How many Runs one demo Subagent can perform before it runs out of script.
 *
 * A fake consumes one script per Run and fails a Run it has no script for, so
 * this is the number of times a demo Subagent can be resumed. Generous rather
 * than unbounded: a bounded list is what makes the fake's behaviour a value a
 * test can read.
 */
const DEMO_SCRIPT_RUNS = 32;

/**
 * How a demo Run opens its answer, before echoing the brief it was given.
 *
 * Echoing is what makes the demo worth having: an answer that named itself
 * would prove a Run ran, and an answer that repeats the question proves the
 * brief reached the backend and came back through the projection, the Result
 * store, `agent_result`, and the notification preview unchanged.
 */
export const DEMO_ANSWER_PREFIX = "The demo subagent was asked: ";

/** What a demo Run answers with, for a given brief. */
export function demoAnswer(prompt: string): string {
  return `${DEMO_ANSWER_PREFIX}${prompt}`;
}

/** What a demo Run reports it is doing, so a widget row has an activity tail. */
export const DEMO_ACTIVITY = "thinking";

const DEMO_RUN: readonly FakeStep[] = [
  emitActivity(DEMO_ACTIVITY),
  { step: "echo-prompt", prefix: DEMO_ANSWER_PREFIX },
  { step: "cumulative-usage", total: { input: 12, output: 8 } },
  { step: "complete", ending: answeredEnding() },
];

/**
 * Build the demo backend set.
 *
 * A function rather than a constant, because each Session gets its own fakes:
 * a fake retains a conversation and a provider-cumulative token total, and two
 * Sessions sharing one would share both.
 */
export function createDemoBackendSet(): BackendSet {
  const perRun = scripts(
    ...Array.from({ length: DEMO_SCRIPT_RUNS }, () => DEMO_RUN),
  );
  const resumable = createFakeResumableBackend({
    scripts: perRun,
    id: DEFAULT_BACKEND_ID,
  });
  const oneShot = createFakeOneShotBackend({
    scripts: perRun,
    id: DEMO_ONE_SHOT_BACKEND,
  });

  const profiles: readonly Profile[] = [
    {
      name: DEMO_RESUMABLE_PROFILE,
      description:
        "A demo specialist that answers immediately and can be resumed and steered.",
      backend: resumable.backend.id,
      fields: {},
      systemPrompt:
        "You are a demonstration subagent. You answer at once, you accept " +
        "steering, and you can be resumed for a second Run.",
    },
    {
      name: DEMO_ONE_SHOT_PROFILE,
      description:
        "A demo specialist that answers once and supports neither resume nor steering.",
      backend: oneShot.backend.id,
      fields: {},
      systemPrompt:
        "You are a demonstration subagent with no retained conversation. You " +
        "answer once and cannot be resumed or steered.",
    },
  ];

  return {
    name: DEMO_BACKEND_SET_NAME,
    backends: [resumable.backend, oneShot.backend],
    profiles,
  };
}
