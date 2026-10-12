import assert from "node:assert/strict";
import test from "node:test";

import { updateExtensionWidgets } from "./extension-widgets.ts";

const tasks = { key: "tasks", lines: ["Tasks: idle"], placement: "belowEditor" };
const fleet = { key: "fleet", lines: ["Fleet: idle"], placement: "belowEditor" };

test("updates competing widgets without changing their order", () => {
  const afterTasksUpdate = updateExtensionWidgets(
    [tasks, fleet],
    "tasks",
    ["Tasks: running"],
    "belowEditor",
  );
  const afterFleetUpdate = updateExtensionWidgets(
    afterTasksUpdate,
    "fleet",
    ["Fleet: running"],
    "belowEditor",
  );

  assert.deepEqual(afterFleetUpdate.map((widget) => widget.key), ["tasks", "fleet"]);
  assert.deepEqual(afterFleetUpdate.map((widget) => widget.lines), [
    ["Tasks: running"],
    ["Fleet: running"],
  ]);
});

test("appends new widgets and removes cleared widgets", () => {
  const withFleet = updateExtensionWidgets([tasks], "fleet", fleet.lines, fleet.placement);
  assert.deepEqual(withFleet.map((widget) => widget.key), ["tasks", "fleet"]);

  const withoutTasks = updateExtensionWidgets(withFleet, "tasks", undefined);
  assert.deepEqual(withoutTasks, [fleet]);
});
