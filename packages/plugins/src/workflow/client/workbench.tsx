/**
 * Dedicated right workbench panel surface entrypoint for builtin:workflow.
 * Loaded lazily only when the user opens the workbench panel.
 */
import './styles.css'
import './styles-trace-rows.css'
import './styles-workbench.css'
import './styles-execution-tree.css'
import './styles-subagent-stream.css'
import './styles-workflow-run.css'
import './styles-worktree-inspect.css'
export { WorkflowWorkbenchPanel } from './WorkflowWorkbenchPanel.tsx'
