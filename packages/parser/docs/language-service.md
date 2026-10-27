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

`project.analysis.analyze()` joins pending resource updates and produces a current semantic view. `Code.parse()` performs syntax work; callers needing symbols and diagnostics should await project analysis. Compatibility methods that analyze synchronously cannot wait for a pending asynchronous resource update.

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

`Code.getCompletionCandidatesAt()` groups members by name across all possible receiver types, preserving their real `symbols`, combined point-specific `type`, and `availability.present` / `availability.total` counts. Unknown or non-member-bearing alternatives contribute no known members and remain part of the availability denominator; a wholly unresolved dot receiver has an empty completion namespace.

## Editor buffers and edits

Hosts provide two optional `ProjectOptions` callbacks:

- `documentText(absolutePath)` returns current editor-owned text, including an empty string, or `undefined` when disk owns the document. Pending disk reads cannot overwrite a newer buffer or revive a retired `Code`.
- `applyEdits(batch)` applies a validated symbol/resource edit through the host's buffer and file-operation APIs. This preserves unsaved text and moves open documents with renamed resources.

A `ProjectEditBatch` contains a label, document snapshots with `expectedText` and **half-open** offset edits, ordered file/directory renames, and a `validate()` callback. Document edits address the old paths and precede the renames. After asynchronous document acquisition, recheck every snapshot and call `validate()` immediately before submission.

Return `false` only when rejecting before application. Throw when an application attempt fails, preserving affected paths and any possibility of partial changes. Multiple file operations are not a cross-filesystem atomic transaction. VS Code's text-only workspace edits are all-or-nothing; mixed resource edits can stop after an earlier operation succeeded. Blind inverse edits may overwrite concurrent user changes.

`planReferenceRename()` validates a complete reference set before producing edits. Pass the project's full reference collection when macros are involved. Storage collisions, lexical capture, incompatible overlapping roles, and ambiguous shared spellings in union members or macro expansions are rejected. Qualified type annotations preserve their namespace when the referenced declaration is renamed. Struct shorthand retains independent property and value identities, expanding to an explicit pair when required.

## Type and flow inference

User-defined functions support omitted and additional arguments according to GML semantics. Native signatures retain their required-argument checks. Callable guards establish callable values; constructor capability remains unknown until a concrete function contract establishes it. A self-only annotation describes a function's receiver, while a type annotation constrains the variable's stored value.

Native `array_create` and `ds_*_create` container factories use distinct allocation-site storage, while assigned aliases retain shared storage. Container element summaries combine possible writes rather than modeling every runtime element. Known object arguments refine the results of `instance_create`, `instance_create_depth`, and `instance_create_layer`. Generic instance handles permit dynamic fields without changing the shared native specification or becoming arbitrary callable values. Unbound dependent native return types remain unknown.

Flow analysis tracks writes, branches, loop exits, returns, and throws; annotations and known container keys supply additional type information. Constant switch selectors restrict reachable entries while preserving fallthrough. `with` accounts for zero, single, or repeated targets and owns its `break`/`continue` boundary; `return`, `throw`, and `exit` propagate outward. Nullish operators evaluate right-hand runtime effects only on paths where the left value can be `undefined` or `pointer_null`; `??=` retains the receiver and index captured before those effects.

## Conservative analysis boundaries

GML's runtime-generated names, dynamic instance selection, and arbitrary string-based lookup can exceed static knowledge. Unknown values remain conservative. Recursive container types form finite type graphs. Type text uses `...` for recursive edges or after 8,192 displayed type nodes, keeping heavily shared graphs from expanding into exponential hover text. This presentation budget leaves inference and the underlying graph unchanged; `...` is a display marker rather than a Feather annotation. Enum analysis distinguishes compile-time eligibility from a runtime literal inferred for a user variable; uncertain native constant results retain explicit uncertainty instead of fabricated enum values. Operator grouping or numeric precision without sufficient target evidence is left unfolded.
