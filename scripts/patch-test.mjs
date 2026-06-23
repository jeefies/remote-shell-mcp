import assert from "node:assert/strict";
import { applyPatchHunks, parseCodexPatch } from "../dist/util/patch.js";

const patch = `*** Begin Patch
*** Add File: hello.txt
+hello
+world
*** Update File: app.txt
@@
 old
-line
+value
*** Delete File: gone.txt
*** End Patch`;

const operations = parseCodexPatch(patch);
assert.equal(operations.length, 3);
assert.equal(operations[0].type, "add");
assert.equal(operations[0].content, "hello\nworld\n");
assert.equal(operations[1].type, "update");
assert.equal(operations[2].type, "delete");

const applied = applyPatchHunks("old\nline\nnext\n", operations[1].hunks, "app.txt");
assert.equal(applied.content, "old\nvalue\nnext\n");
assert.equal(applied.appliedHunks.length, 1);

assert.throws(
  () => parseCodexPatch("*** Begin Patch\n*** Update File: x\nbad\n*** End Patch"),
  /Update File sections must contain @@ hunks/,
);

assert.throws(
  () => applyPatchHunks("nothing\n", operations[1].hunks, "app.txt"),
  /Patch hunk did not match file content/,
);

assert.throws(
  () => applyPatchHunks("old\nline\nold\nline\n", operations[1].hunks, "app.txt"),
  /Patch hunk matched more than once/,
);

console.log("patch tests passed");
