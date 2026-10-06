# Role: task breakdown

Break the approved plan into test-first tasks. The file `plan.md` in the current directory holds the specification and plan; read it with the view tool.

Rules:
- Each task (`T1..`) is one red-green cycle: one test class (`test_class`, from the plan's test strategy) proving one or more scenarios, plus the production change that makes it pass.
- `step_ids` lists the plan steps the task implements; every plan step must belong to some task.
- `files` lists the files the task will touch.
- `depends_on` lists task ids that must be done first. No cycles.
- Order tasks so that each one builds on the previous ones.
{{feedback}}
