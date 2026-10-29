# Language analysis and editor integration

Stitch analyzes GML as a project: scripts, object events, room and instance creation code, timeline moments, GML extensions, native specifications, configuration-specific macros, and resource relationships contribute to the same view. Syntax normalization, binding, type evaluation, legality checking, and publication are separate phases. A dependency worklist updates consumers when declarations, inferred returns, members, or previously missing names change.

## Loading and updating

```ts
import { Project } from '@bscotch/gml-parser';

const project = await Project.initialize('path/to/game/game.yyp', {
  onDiagnostics({ filePath, diagnostics }) {
    // Replace the diagnostics displayed for this file. An empty array clears it.
    console.log(filePath, diagnostics);
  },
});

const code = project.getGmlFile(
  project.dir.join('scripts/movement/movement.gml'),
);
if (code) {
  // Analyze replacement text without saving it to disk.
  await code.reload('function movement() { return 4; }');
  console.log(code.analysisState, code.refs);
}

// Reconcile an externally changed project resource list.
await project.reloadYyp();
// Reconcile one listed resource after YY/GML creation, change, or deletion.
await project.reloadResource(project.dir.join('objects/player/player.yy'));

// Release references, diagnostics subscriptions, and pending analysis ownership.
project.dispose();
```

Project initialization and resource-management commands can change project files. Use a disposable project copy for tooling experiments and keep source control enabled.

`project.analysis.analyze()` joins pending resource updates and produces a current semantic view. `Code.parse()` performs syntax work; callers needing symbols and diagnostics should await project analysis. Compatibility methods that analyze synchronously cannot wait for a pending asynchronous resource update. An explicit `Code.updateDiagnostics()` refresh also publishes that document's current diagnostics, including when no analysis is pending.

### State and diagnostics

`Code.analysisState` contains `contentVersion`, `syntaxVersion`, `semanticVersion`, `projectVersion`, and `status`:

| Status                | Meaning                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `unparsed` / `parsed` | The document has not completed semantic analysis for its current inputs.                                     |
| `complete`            | Analysis completed for the committed inputs. User-code diagnostics may still exist.                          |
| `degraded`            | A current best-effort result is available, with recoverable syntax errors or explicitly uncertain semantics. |
| `failed`              | An internal or input-loading failure prevented a trustworthy result.                                         |
| `retired`             | The document no longer belongs to this project view.                                                         |

Check `project.analysis.isCurrent` as well as document state before using cached results. A configuration, native specification, or resource change can invalidate semantics without changing document text. `project.analysis.error` retains an analysis failure; a subsequent valid input update permits recovery.

Diagnostics are replacement publications per URI. Removed documents publish an empty collection. Lexer, parser, annotation, and semantic diagnostics remain distinct contributors; malformed annotations retain recoverable surrounding code. Internal failures are reported through the `ANALYSIS` collection and contextual logs rather than a successful empty symbol table.

### Analysis transactions and publication

Each transaction fixes the current document revisions, macros, language profile and resource contexts, then binds declarations before evaluating source bodies. Native metadata, resources, macros and individual source units own separate contributions. Replacing a unit removes its earlier contribution, so deleted members and declarations can retire as well as appear. Contribution versions are immutable: index branches share unchanged per-key source sets and ordering caches, copying source sets when their entries change. Cold script and extension scheduling uses bound provider/read hints; dependencies drive subsequent fixed-point reevaluation.

The worklist tracks reads of exported types, storage, callable implementations and missing names. Export summaries retain storage identities and callable origins: two equal-looking structures can represent different mutable storage. Executable body versions are tracked separately from a callable's address and exported shape, allowing an unchanged sibling export to retain its consumers. Borrowed shapes and shared-alias traversal register dependencies on the storage they inspect.

Actual value reads and writes also identify cross-unit feedback through container items, shared members and callable results. A feedback component withdraws its earlier contributions and recomputes with outside inputs fixed. Internal changes propagate immediately; outside consumers are notified of the component's final changes, retired identities and required declaration-only retries. This permits old values to disappear from mutually supporting writes while preserving independent contributors. Newly allocated data structures begin with no inferred item facts; unresolved presentation remains `Any`, and actual unknown input values remain contributors.

Loop and repeated-`with` analysis compare complete flow states, including values, mutable-storage aliases, conditional constraints, reachability and initialized statics. Equal-shaped containers retain distinct identities when later writes can distinguish them; scalar values compare independently of their native specification addresses. A bounded frozen-graph history accelerates these comparisons; crossing its representation budget transfers all retained states to canonical fingerprint comparison. At project level, cycle detection includes unit summaries, dependencies, value-flow ports, resource bases, first-evaluation eligibility and ordered pending work. Active components retain their comparison baselines and deferred outside queue in that state. A repeated complete scheduling state reports an analysis failure.

Publication first prepares a detached graph and validates the evaluation views selected for replacement, then updates stable public handles synchronously. Definition-location changes can refresh references without reevaluating their source bodies. Changed function-use counts can republish provider diagnostics while preserving that provider's semantic version. Cross-file macro references are grouped by their contributing unit and withdrawn with failed or retired views.

Revision checks discard cancelled work before publication. A reusable private publication buffer has one owner; a failed or cancelled preparation cannot be reused by the next transaction. Editor queries observe committed generations, with current-input checks at asynchronous boundaries.

## Runtime and language capabilities

Native functions, variables, structures, and enums come from the selected runtime's GmlSpec files. Explicit `runtimeVersion` in `stitch.config.json` takes precedence in runtime selection; the project's IDE version supplies the default discovery input. Selected specification failures report their path and `read`, `xml`, `schema`, or `load` stage.

`project.native.getSpecSources()` exposes the effective source path, module, declared runtime, SHA-256, and bundled-fallback flag. `getSpecs()` provides immutable metadata snapshots. Bundled data can contain newer or backported entries, so its header does not establish the project's target version. Fallback use is reported; unknown target capabilities remain unknown.

The syntax/semantics profile complements native signatures:

| Release boundary | Language behavior                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Before 2.3       | Script resources are callable units with legacy argument and local scope behavior.                                         |
| 2.3              | Global-startup scripts, function expressions, constructors, structs, statics, chained accessors, exceptions, and `delete`. |
| 2.3.7            | `??` and `??=` nullish operators.                                                                                          |
| 2023.4           | Template-string syntax.                                                                                                    |

Function-specific availability and signatures, including supported `static_get` inputs, follow the selected specification. Native `Get`/`Set`, enum values, deprecation, and declaration identity are retained. `Locale`, `FeatureFlag`, and `Pure` metadata are preserved for inspection; they are not sufficient evidence for target exclusion or mathematical constant folding.

The profile uses a known runtime version first, then the IDE version, then nonbundled Base-spec metadata. Unknown versions permit conservative analysis without inventing historical support. This capability model is not a certification that every old runtime, target platform, or project-file format has been exercised.

Sources: [2.3 language changes](https://gamemaker.io/en/blog/gamemaker-studio-2-dot-3-new-gml-features), [2.3.7 runtime notes](https://gms.yoyogames.com/release-notes-2.3.7.474.json), [2023.4 release](https://gamemaker.io/en/blog/release-2023-4).

### Native names and user global storage

Bare native names and explicitly qualified user globals have separate identities. For example, writing `global.fps` defines user storage while the bare `fps` remains the runtime's read-only value. A `globalvar` declaration does not make a native constant writable.

A top-level named function can share a native name. Its declaration and `global.name` references identify the user function; a bare reference to that name still identifies the native function. This distinction also applies when a bare function reference is stored in another variable. Compiler-generated code on the 2024.14 and 2026 runtime lines confirms these separate lookup paths. A `var` declaration cannot reuse a built-in name; parameter and static declarations follow their distinct compiler rules.

`project.analysis.globalStorage` exposes the canonical user-global container, initially empty before publication. Use it to enumerate user declarations, including functions whose names collide with native names. `project.self` is the combined bare-name presentation used by ordinary completion. Qualified completion, definition, references, and rename retain the underlying storage identity.

Sources: [global variables and the global struct](https://manual.gamemaker.io/lts/en/GameMaker_Language/GML_Overview/Variables/Global_Variables.htm), [script functions and methods](https://manual.gamemaker.io/lts/en/GameMaker_Language/GML_Overview/Script_Functions_vs_Methods.htm).

## Resource-owned GML

The current YYP and YY metadata select executable files. Unlisted event files, timeline moments, disabled instance creation files, and unrelated GML files remain outside the analysis. Nested room instance layers are included.

| Source                 | Analysis context                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Script / object event  | Versioned script semantics or the declaring object's instance scope.                                                                      |
| Instance creation code | A placed-instance scope derived from its object; assignments do not become fields of every instance of that object.                       |
| Room creation code     | A separate room-creation scope. Explicit global writes contribute to project globals.                                                     |
| Timeline moment        | A dynamic caller-instance scope shared by the listed moments. The caller's concrete object type is not inferred from timeline assignment. |
| GML extension file     | Each `#define` section is a callable implementation within one physical source document, including on legacy targets.                     |

Extension YY names and external implementation names are linked for navigation. Multiple public aliases retain their own parameter signatures, while implementation analysis combines the possible implicit argument types. Typed parameter entries retain their declared positions, including in legacy metadata with a zero `argCount`. A positive `argCount` supplies any additional untyped slots; those parameter types remain unknown. A negative count keeps the typed prefix and permits additional arguments. Hidden functions remain callable and navigable but are omitted from completion. Metadata-backed names are excluded from GML-only rename. Extension constants currently retain scalar or unknown metadata types; arbitrary extension macro bodies are not expanded as GML text.

Metadata-only changes rebind source contexts. Removing a source from YY retires its analysis without deleting the file. Explicit source deletion updates the corresponding metadata, and room rename rewrites its creation-code path. Source lookup and refresh also follow project-relative paths outside a resource's directory.

A physical file referenced in different execution contexts, within one resource or across resources, produces metadata warnings and is excluded from semantic analysis. Source deletion is rejected while another resource references the file; removing one metadata owner restores the surviving context. Missing optional creation-code files are warnings because metadata can retain empty or stale bodies. If a room's declared creation path is missing but its resource-local `RoomCreationCode.gml` exists, that file is analyzed with a warning; the target compiler's path resolution is not assumed to be verified.

Sources: [room properties](https://manual.gamemaker.io/monthly/en/The_Asset_Editors/Room_Properties/Room_Properties.htm), [timelines](https://manual.gamemaker.io/monthly/en/The_Asset_Editors/Timelines.htm), [GML extensions](https://manual.gamemaker.io/monthly/en/The_Asset_Editors/Extension_Creation/Creating_An_Extension.htm).

## Object Variable Definitions

Object-editor Variable Definitions contribute instance fields before Create-event analysis, including inherited definitions when a child has its own Create event without `event_inherited()`. This metadata inheritance is independent of executing the parent's Create code.

Numeric, integer, and colour definitions start as `Real`; string and Boolean definitions start as `String` and `Bool`. Multiple-selection lists start as arrays of unknown elements. Expressions, assets, and single-selection lists retain unknown values when the metadata does not establish a reliable runtime type. Later GML assignments update the current flow value; project-wide storage summaries can include both initial and written types.

`Signifier.resourceDefinition` records the declaring YY resource and field name. These fields participate in completion and type analysis, but GML rename is disabled because their authoritative declaration is metadata. Removing a definition or changing the parent refreshes its provenance. Default expressions and per-instance room overrides remain unparsed metadata: their embedded GML references and source locations are not analyzed. YY definition navigation/editing and editor value-choice validation are not provided.

Source: [Object Variables](https://manual.gamemaker.io/monthly/en/The_Asset_Editors/Object_Properties/Object_Variables.htm).

## Macros and source locations

Macro definitions are collected project-wide before expansion. Expansion supports forward and nested references, configuration qualifiers, and backslash continuations, including trailing comments after a continuation marker. Each invocation is analyzed in its own scope. Recursive expansion and conflicting definitions produce local diagnostics while recoverable surrounding code remains available.

```gml
#macro MOVE_SPEED 4
#macro Debug:MOVE_SPEED 1
#macro MOVE_DIAGONALLY \
    x += MOVE_SPEED; \
    y += MOVE_SPEED;
```

Select an existing project configuration using `project.setAnalysisConfiguration(name)` or `ProjectOptions.settings.analysisConfiguration`. The selected configuration inherits its parents' macro overrides. The standalone default is the first child configuration, or the root configuration when it has no children.

Source maps distinguish author-written spellings from invocation anchors. A macro body can have references in several invoking scopes. Definition/reference queries retain those distinctions; rename rejects a shared spelling when different expansions bind it to different symbols.

Public `Position`/`Range` locations use zero-based **inclusive offsets** and one-based lines/columns. `Reference.queryRange` is an invocation-side query location when it differs from the physical spelling range. Converting a public range to an editor text edit requires an exclusive end.

`Code.getReferenceCandidatesAt()` returns the possible bindings at a query position; `getReferenceAt()` returns a reference only when the binding is unique. Invocation names and shorthand value roles retain their normal query priority. `Reference.evaluatedType` describes the value at that use, while `Signifier.type` summarizes the symbol's storage across analyzed paths. Editors can show all known definitions and hover types for a union member without choosing an arbitrary branch.

`Code.getCompletionCandidatesAt()` groups members by name across all possible receiver types, preserving their real `symbols`, combined point-specific `type`, and `availability.present` / `availability.total` counts. Unknown or non-member-bearing alternatives contribute no known members and remain part of the availability denominator; a wholly unresolved dot receiver has an empty completion namespace. Completion kinds and semantic highlighting combine receiver alternatives consistently: a member that may be noncallable retains variable or property coloring rather than an unconditional function color. `Code.getScopeCandidatesAt()` also exposes the lexical receiver alternatives inside `with`, preserving local-name precedence in every branch. The singular compatibility method `getScopeRangeAt()` prefers a concrete receiver at the selected range when one is known.

## Editor buffers and edits

Hosts provide two optional `ProjectOptions` callbacks:

- `documentText(absolutePath)` returns current editor-owned text, including an empty string, or `undefined` when disk owns the document. Pending disk reads cannot overwrite a newer buffer or revive a retired `Code`.
- `applyEdits(batch)` applies a validated symbol/resource edit through the host's buffer and file-operation APIs. This preserves unsaved text and moves open documents with renamed resources.

A `ProjectEditBatch` contains a label, document snapshots with `expectedText` and **half-open** offset edits, ordered file/directory renames, and a `validate()` callback. Document edits describe the original paths and text; `renamedPath()` maps those paths through the ordered moves. After asynchronous document acquisition, recheck every snapshot and call `validate()` immediately before submission. Hosts adapt the plan to their working-copy and undo model: the VS Code adapter separates dependent child/parent moves into ordered resource groups, then edits the final documents in the same workspace edit. Moved open buffers join that edit's Undo scope, and whole-directory moves preserve directory restoration. Metadata buffer changes join resource reconciliation, including unsaved changes made by Undo. On Windows, VS Code 1.143.1 can leave dependent child/parent resource moves unchanged when Redo follows Undo. To apply the rename again after Undo, invoke Rename again so the project and current buffers produce a fresh validated plan.

Return `false` only when rejecting before application. Throw when an application attempt fails, preserving affected paths and any possibility of partial changes. Multiple file operations are not a cross-filesystem atomic transaction. VS Code's text-only workspace edits are all-or-nothing; mixed resource edits can stop after an earlier operation succeeded. Blind inverse edits may overwrite concurrent user changes.

`planReferenceRename()` validates a complete reference set before producing edits. Pass the project's full reference collection when macros are involved. Storage collisions, lexical capture in either direction, incompatible overlapping roles, and ambiguous shared spellings in union members or macro expansions are rejected. Qualified type annotations preserve their namespace when the referenced declaration is renamed. Struct shorthand retains independent property and value identities, expanding to an explicit pair when required. A property referenced exclusively through quoted keys accepts arbitrary string names, including an empty name, with escaping applied to each source edit; ordinary identifier references retain identifier validation.

## Type and flow inference

User-defined functions support omitted and additional arguments according to GML semantics. Native signatures retain their required-argument checks. Callable guards establish callable values; constructor capability remains unknown until a concrete function contract establishes it. A self-only annotation describes a function's receiver, while a type annotation constrains the variable's stored value.

Native `array_create` and `ds_*_create` container factories use distinct allocation-site storage, while assigned aliases retain shared storage. Container element summaries combine possible writes rather than modeling every runtime element. Contextual static assignments and indexed container writes keep incoming flow values separate from their actual write contributions, allowing obsolete types to retire after a provider changes. Known object arguments refine the results of `instance_create`, `instance_create_depth`, and `instance_create_layer`. Generic instance handles permit dynamic fields without changing the shared native specification or becoming arbitrary callable values. Unbound dependent native return types remain unknown.

Flow analysis tracks writes, branches, loop exits, returns, and throws; annotations and known container keys supply additional type information. A declaration's `@type` applies to every variable in that declaration statement, and a later annotation constrains subsequent writes without changing earlier reference types. Constant switch selectors restrict reachable entries while preserving fallthrough. `with` evaluates its target once and combines all possible receivers, accounting for zero, single, or repeated targets. It owns its `break`/`continue` boundary; `return`, `throw`, and `exit` propagate outward. Nullish operators evaluate right-hand runtime effects only on paths where the left value can be `undefined` or `pointer_null`; `??=` retains the receiver and index captured before those effects.

### Invocation contexts and game options

`options/main/options_main.yy` supplies `option_legacy_other_behaviour` as a Boolean semantic input. `false` selects modern invocation-dependent `other`; `true` retains legacy behavior, where `with` and `new` change `other`. Bound methods retain their `self` independently from the caller's `other`. Modern bound-constructor calls use the bound receiver as `other`; legacy constructor calls use the scope where `new` executes. Direct struct-member calls and calls through a stored alias can consequently have different invocation contexts.

An absent file or option leaves the mode unknown and publishes an informational diagnostic. A malformed file or non-Boolean value publishes an error and clears the previous mode. Analysis remains available with conservative invocation-dependent types. Reload this path through `project.reloadResource()` after external changes; the VS Code metadata watcher uses this same reconciliation path.

Context-sensitive calls track their arguments, caller storage and return graphs together. Independent allocation sites retain separate mutable storage, while returned aliases, bound receivers and constructor statics preserve their shared identities. Recursive summaries use a fixed point rather than an arbitrary pass limit. Default arguments have runtime effects only on missing or possibly undefined paths, while their source references and annotations remain available for navigation.

Sources: [other and Legacy Other Behaviour](https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Overview/Instance%20Keywords/other.htm), [method](https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Reference/Variable_Functions/method.htm), [static variables](https://manual.gamemaker.io/lts/en/GameMaker_Language/GML_Overview/Functions/Static_Variables.htm).

## Conservative analysis boundaries

GML's runtime-generated names, dynamic instance selection, and arbitrary string-based lookup can exceed static knowledge. Unknown values remain conservative. Recursive container types form finite type graphs. Type text uses `...` for recursive edges or after 8,192 displayed type nodes, keeping heavily shared graphs from expanding into exponential hover text. This presentation budget leaves inference and the underlying graph unchanged; `...` is a display marker rather than a Feather annotation. Complete type serialization rejects unrepresentable recursion or an exhausted output budget. Copy Type and Copy `@type` use complete serialization and preserve all union alternatives; Copy `@self` requires the single receiver accepted by that annotation's grammar. Enum analysis distinguishes compile-time eligibility from a runtime literal inferred for a user variable; uncertain native constant results retain explicit uncertainty instead of fabricated enum values. Operator grouping or numeric precision without sufficient target evidence is left unfolded.
