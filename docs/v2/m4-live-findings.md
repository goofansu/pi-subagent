# What driving M4 against a real Pi host turned up

**Date:** 2026-09-03
**Context:** M4 landed with the Pi adapter passing the shared conformance suite
and two opt-in live gates green. These are the things that only showed up when
the extension was switched on as the daily driver and poked at by hand — plus,
because it turned out to matter more than the findings themselves, how each one
was actually established.

The short version: the adapter and the runtime behaved. Every defect was in the
parts *around* them — id allocation and a widget policy — and none was reachable
by the tests that exist, for reasons worth recording.

---

## 1. The first Run of every Session was `run-2`

**Severity 3 — a confusing surface, fixed.**

`agent_start` reported `subagent id subagent-1, run id run-2`. There was no
`run-1`, and the numbering kept a hole in it wherever a Subagent was created:
the M4 live gate's four Runs came out `run-2, run-3, run-5, run-7`.

**Cause.** `RunRepository` had one sequence counter shared by both allocators:

```ts
let sequence = 0;

const allocate = (spent, prefix, brand) =>
  Ref.modify(spent, (ids) => {
    sequence += 1;
    const value = `${prefix}-${sequence}`;
    ...
  });
```

`start` allocates the Subagent id and then the Run id, so the Subagent took 1
and its Run took 2. A resume allocates only a Run, which is why the gaps fell
where they did.

Two things make this an accident rather than a decision. Each kind already
keeps its **own** spent set, so the design clearly intended two independent
sequences; and nothing is disambiguated by the shared counter, because the
`run-` and `subagent-` prefixes already do that.

**Fix.** One sequence per kind. The first Run of a Session is now `run-1`,
confirmed both by a unit test and against a real Pi host.

**Why no test caught it.** Every test that touched the numbering had the
off-by-one written into it — five of them asserted `run-2` for a Session's
first Run. They were written by reading the output and pinning it, which pins
a defect exactly as readily as it pins a behaviour. The new test states the
rule instead of the observation: each kind is numbered from one, independently
of the other.

The lesson generalises past this bug. A golden test is only as good as the
first run someone eyeballed, and "assert what it printed" is not the same as
"assert what it should print". Where a value has a *rule* behind it, the test
should say the rule.

## 2. The widget disappears the moment a Run settles

**Severity 3 — a parity break, open by decision.**

v1's widget lists every *tracked* Run, and a Run stays tracked until its
completion notification reaches the model — so a v1 row is on screen from
`agent_start` until the answer lands in the conversation. v2's widget lists
Runs that are not terminal, so the row goes the instant the Run settles, which
is usually well before the notification lands and often within the same turn.

The practical effect is that for anything but a long Run the widget appears and
vanishes before it is read, and v2 reads as having no widget at all.

This is a deliberate M3 decision, written into `host/widget.ts`: *"the row's
job here is to show what is live."* The reasoning is coherent; what it did not
account for is that a row nobody sees is not showing anything. The
compatibility matrix's Active widget row promises the widget is "removed when
none are left" and cites v1's tests for it, so v2 diverges from a promised
behaviour with no **[v2 change]** marker — which makes it a parity break rather
than a matter of taste.

Left open deliberately, with the fix described in
[the soak record](soak.md#the-widgets-row-lifetime-2026-09-03-severity-3): keep
a terminal Run's row until its notification has landed, which the Session push
sink already tracks.

## 3. Ids restart at 1 on a session reload, and the transcript does not

**Severity 1 — a wrong answer presented as right. Open, needs a decision.**

Resuming a Pi session starts a new process, a new Session runtime, and a new
`RunRepository` — so Run and Subagent ids begin again at 1. **That much is
intended**, and the compatibility matrix says so twice: *"Local Subagent and Run
identity sets are forgotten at the Session boundary"* and *"After Session
shutdown — Nothing is retrievable: Results belong to the Session that asked."*
The Subagents, their retained Pi sessions, and their stored Results all die with
the process; ids that outlived them would point at nothing.

What is **not** intended is the consequence. The conversation transcript
survives the reload and the ids do not, so an id written before the reload can
be handed to a *different* Run after it. Two cases, and only the first is safe:

- **Before a new Run has taken the id**, a stale reference is reported as
  unknown. Honest, and observed in a real session: `agent_resume subagent-1`
  after a reload answered *"Cannot resume subagent subagent-1: unknown
  Subagent."*
- **After a new Run has taken the id**, the stale reference silently resolves
  to the wrong Run. Demonstrated through the host rig, one process, two
  Sessions:

  ```
  first run id : run-1        # Session A, brief "one"
  second run id: run-1        # Session B after the reload, brief "two"
  stale lookup : explore (subagent subagent-1), run run-1: two · pi · completed
  ```

  Asking for the first Session's `run-1` returned the second Session's Run —
  note the brief reads `two`. Nothing in the answer says it is a different Run.

**Why it is likely rather than theoretical.** The completion notice this
extension writes into the conversation says *"Use agent_result with id run-1 to
retrieve the full result."* That sentence survives the reload, so the transcript
actively invites the model to use an id that has since been reassigned. The
attractor is our own prose.

**It is a v1 regression.** v1 minted `run-${crypto.randomUUID().slice(0, 8)}`,
random per Run, so a stale id after a reload was always unknown and never
silently wrong. v2's sequential ids made the collision certain rather than
impossible — readable ids bought at the cost of a correctness property nobody
noticed was there.

**The fix, and the trade-off.** Give each Session runtime a short random nonce
and mint `run-<nonce>-1`, `run-<nonce>-2`. Sequence and readability survive
within a Session; collisions across a reload do not. The change is contained in
the allocator. The cost is that ids stop being as short and as pleasant to type
as `run-1`, which is a real loss for a single-user tool where the hazard needs
a model to re-read an old part of the transcript.

Left open deliberately: unlike the shared-counter defect above, this is a
trade-off rather than a mistake, and the id format is read constantly.

---

## How these were established, and why it was harder than it should have been

### RPC mode cannot see a factory widget

The obvious way to check the widget from a script is to launch Pi with
`--mode rpc` and watch for `setWidget`. That does not work, and it fails
**silently**:

```js
setWidget(key, content, options) {
    // Only support string arrays in RPC mode - factory functions are ignored
    if (content === undefined || Array.isArray(content)) { output({...}); }
    // Component factories are not supported in RPC mode - would need TUI access
}
```

v2's widget is a component factory, so RPC drops it and reports nothing. The
first probe therefore showed no widget and *proved nothing* — it would have
looked identical if the widget were completely broken. An absent signal from a
channel that cannot carry the signal is not evidence.

### Driving the model to reach the code is unreliable

Two attempts to reach `agent_start` by asking a model to call it produced no
Run at all: once the model answered in prose, once the turn outran the
timeout. Neither told me anything about the code under test, and both cost a
provider turn.

What worked was removing the model from the loop: a throwaway extension that
installs the real v2 entry against the real Pi host, captures the registered
tool handlers as they are registered, and calls `agent_start`'s `execute`
directly on `session_start`. That is deterministic, costs one subagent Run, and
exercises the entire host path — registration, the Session runtime, the Pi
adapter, and the widget — with nothing guessing in the middle.

It is worth keeping as a technique. **When the thing under test is behind a
model's discretion, take the model out.**

### The evidence it produced

```
install guard: childLoad=false depth=0
registered six tools            # the parent registers everything
probe: calling agent_start directly
change size=0 live=0
install guard: childLoad=true depth=0
                                # the child registers nothing at all
change size=1 live=1
install rows=1                  # the widget installs with one live row
change size=1 live=1            # redraws while the Run runs
change size=1 live=0            # the Run settles
uninstall installed=true        # the row goes at once
probe: agent_start returned ... subagent id subagent-1 run id run-2
```

Three facts in one log: the widget machinery is sound and the *policy* is what
differs; the id sequence is off by one; and the inert-in-child guard fires in a
real Pi child, which until then had only test coverage behind it.

### The gap that let both through

**Nothing exercises the host surface against a real Pi host.** Every host test
runs against `testing/stand-in-host.ts`, which is a double I wrote — so it
agrees with my assumptions about `setWidget` by construction, and a signature
or lifecycle mismatch with the real host would not show up. The live lane
drives the Session *runtime* and never touches the host UI.

That is the hole both of these findings sat in, and it is the one structural
thing worth doing something about. The probe extension above is most of a
host-level live gate already; making it a checked-in script alongside
`v2:pi:host-smoke` — asserting that a live Run installs the widget, that the
child registers nothing, and that the ids read as expected — would close it.

Recorded rather than done, because it is M5-shaped work and M4's exit gate does
not ask for it.
