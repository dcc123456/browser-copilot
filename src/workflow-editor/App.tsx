import { useCallback, useEffect, useState, useMemo, memo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  type NodeChange,
  type EdgeChange,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react'
import {
  WORKFLOW_BLOCKS,
  BLOCK_CATEGORIES,
  BLOCK_BY_ID,
} from '../lib/workflow/registry'
import type {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  WorkflowTrigger,
  WorkflowSettings,
  BlockDefinition,
  ParamDefinition,
} from '../lib/workflow/types'
import { sendCommand } from '../lib/messages'
import { newId } from '../lib/storage'
import CodeInput from './CodeInput'

const CATEGORY_LABELS: Record<string, string> = {
  browser: '浏览',
  navigation: '导航',
  data: '数据',
  'control-flow': '流程控制',
  integration: '集成',
  trigger: '触发器',
}

/** Variables the engine exposes by default (see executors / engine loop blocks). */
const BUILTIN_VARIABLES = [
  'loopIndex',
  'loopItem',
  'lastText',
  'lastValue',
  'lastResult',
  'lastAIResponse',
  'lastExport',
  'dataTable',
  'refData',
]

const VAR_TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g

const TRIGGER_LABELS: Record<string, string> = {
  manual: '手动运行',
  scheduled: '定时运行',
  'context-menu': '右键菜单',
  'visit-web': '访问网址',
  github: 'GitHub',
  feishu: '飞书',
}

const DEFAULT_SETTINGS: WorkflowSettings = {
  saveLog: false,
  debugMode: false,
  notification: false,
  reuseLastState: false,
}

function defaultsFromParams(params?: ParamDefinition[]): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  if (!params) return defaults
  for (const param of params) {
    if (param.default !== undefined) {
      defaults[param.name] = param.default
    } else {
      switch (param.type) {
        case 'number':
          defaults[param.name] = 0
          break
        case 'boolean':
          defaults[param.name] = false
          break
        case 'select':
          defaults[param.name] = param.options?.[0] ?? ''
          break
        case 'json':
          defaults[param.name] = '{}'
          break
        case 'string':
        default:
          defaults[param.name] = ''
          break
      }
    }
  }
  return defaults
}

interface CustomNodeData extends Record<string, unknown> {
  blockId: string
  values: Record<string, unknown>
  /** Optional display label; falls back to the block label. */
  label?: string
}

type CustomNode = Node<CustomNodeData>

function CustomNodeComponent({ data, selected }: { data: CustomNodeData; selected: boolean }) {
  const block = BLOCK_BY_ID.get(data.blockId)
  return (
    <div className={`custom-node ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="custom-node-header">
        <div className="custom-node-label">{data.label || block?.label || data.blockId}</div>
      </div>
      {selected && (
        <div className="custom-node-body">
          <div className="custom-node-id">id: {data.blockId}</div>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

const nodeTypes: NodeTypes = {
  custom: CustomNodeComponent,
}

/**
 * The right-side parameter form for whichever node is selected.
 *
 * Memoized so dragging other nodes around on the canvas (which rebuilds every
 * node object) doesn't re-render the form — only the selected node's data or
 * the available-variable list does. That keeps typing into a field smooth and
 * prevents the inspector from visibly lagging a node switch.
 */
interface NodeInspectorProps {
  node: CustomNode | undefined
  block: BlockDefinition | undefined
  values: Record<string, unknown>
  availableVariables: string[]
  onValueChange: (paramName: string, value: unknown) => void
  onLabelChange: (label: string) => void
  onInsertVariable: (paramName: string, varName: string) => void
}

const NodeInspector = memo(function NodeInspector({
  node,
  block,
  values,
  availableVariables,
  onValueChange,
  onLabelChange,
  onInsertVariable,
}: NodeInspectorProps) {
  if (!node) {
    return <div className="inspector-empty">点击画布上的节点以编辑参数</div>
  }

  const renderParamInput = (
    param: ParamDefinition,
    value: unknown,
    withVariableInsert?: boolean,
  ) => {
    const onChange = (newValue: unknown): void => onValueChange(param.name, newValue)
    // JavaScript snippets (JS 代码 / 条件 / 循环条件等) use a highlighted editor.
    if (param.name === 'code') {
      return (
        <CodeInput
          value={(value as string) ?? ''}
          onChange={(v) => onChange(v)}
          placeholder={param.label || param.name}
        />
      )
    }
    switch (param.type) {
      case 'number':
        return (
          <input
            type="number"
            value={Number(value) ?? 0}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        )
      case 'boolean':
        return (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => onChange(e.target.checked)}
            />
            {param.label || param.name}
          </label>
        )
      case 'select':
        return (
          <select value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
            {param.options?.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        )
      case 'json':
        return (
          <textarea
            value={(value as string) ?? '{}'}
            onChange={(e) => onChange(e.target.value)}
            placeholder="{}"
          />
        )
      case 'string':
      default:
        return (
          <div className="var-field-wrap">
            <input
              type="text"
              value={(value as string) ?? ''}
              onChange={(e) => onChange(e.target.value)}
              placeholder={param.label || param.name}
            />
            {withVariableInsert && (
              <select
                className="var-insert-select"
                aria-label="插入变量"
                value=""
                onChange={(e) => {
                  if (e.target.value) onInsertVariable(param.name, e.target.value)
                }}
              >
                <option value="">+ 变量</option>
                {availableVariables.map((name) => (
                  <option key={name} value={name}>
                    {`{{${name}}}`}
                  </option>
                ))}
              </select>
            )}
          </div>
        )
    }
  }

  return (
    <div className="inspector-section inspector-node">
      <h3>节点参数 · {block?.label ?? node.data.blockId}</h3>
      <div className="param-group">
        <label>节点名称</label>
        <input
          type="text"
          value={node.data.label || ''}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder={block?.label ?? node.data.blockId}
        />
        <div className="param-desc">留空则使用该块类型的默认名称</div>
      </div>
      {!block ? (
        <div className="inspector-empty" style={{ padding: '8px 0' }}>
          未知节点类型：{node.data.blockId}
        </div>
      ) : !block.params || block.params.length === 0 ? (
        <div className="inspector-empty" style={{ padding: '8px 0' }}>
          此节点没有可配置参数
        </div>
      ) : (
        block.params.map((param) => (
          <div key={param.name} className="param-group">
            {param.type !== 'boolean' && (
              <label>
                {param.label || param.name}
                {param.required && ' *'}
              </label>
            )}
            {renderParamInput(
              param,
              values[param.name],
              true,
            )}
            {param.description && <div className="param-desc">{param.description}</div>}
          </div>
        ))
      )}
    </div>
  )
})

export default function EditorApp() {
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  const [workflowName, setWorkflowName] = useState<string>('新工作流')
  const [nodes, setNodes] = useState<CustomNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [trigger, setTrigger] = useState<WorkflowTrigger>({ type: 'manual', enabled: true })
  const [settings] = useState<WorkflowSettings>(DEFAULT_SETTINGS)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const [errorBanner, setErrorBanner] = useState<string | null>(null)

  const reactFlow = useReactFlow()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const editId = params.get('edit')
    if (editId) {
      void loadExistingWorkflow(editId)
    } else {
      const id = newId()
      setWorkflowId(id)
      setWorkflowName('新工作流')
      setLastSaved(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadExistingWorkflow = async (id: string): Promise<void> => {
    try {
      const result = await sendCommand({ type: 'workflows.get', id })
      if (result.type === 'workflows.get' && result.workflow) {
        const wf = result.workflow
        setWorkflowId(wf.id)
        setWorkflowName(wf.name)
        const flowNodes: CustomNode[] = wf.drawflow.nodes.map((n) => ({
          id: n.id,
          type: 'custom',
          position: n.position,
          data: {
            blockId:
              (n.data.blockId as string | undefined) ?? 'unknown',
            values: n.data.values
              ? (n.data.values as Record<string, unknown>)
              : n.data,
            ...(n.label ? { label: n.label } : {}),
          },
        }))
        const flowEdges: Edge[] = wf.drawflow.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
        }))
        setNodes(flowNodes)
        setEdges(flowEdges)
        if (wf.trigger) setTrigger(wf.trigger)
        setLastSaved(new Date())
        if (wf.drawflow.position && typeof wf.drawflow.zoom === 'number') {
          const { position, zoom } = wf.drawflow
          window.setTimeout(() => {
            reactFlow.setViewport({
              x: position?.x ?? 0,
              y: position?.y ?? 0,
              zoom,
            })
          }, 0)
        }
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err))
    }
  }

  const onNodesChange = useCallback((changes: NodeChange<CustomNode>[]) => {
    setNodes((nds) => applyNodeChanges<CustomNode>(changes, nds))
    // XYFlow emits a batch of select changes when the user clicks a different
    // node (deselect old, select new) in a single dispatch. Process the whole
    // batch so the inspector jumps straight to the new node instead of briefly
    // rendering the empty state — that flash was the visible "wrong panel".
    let nextId: string | null | undefined
    for (const c of changes) {
      if (c.type !== 'select') continue
      if (c.selected) {
        nextId = c.id
      } else if (nextId === undefined || nextId === c.id) {
        nextId = null
      }
    }
    if (nextId !== undefined) setSelectedNodeId(nextId)
  }, [])

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((eds) => applyEdgeChanges(changes, eds))
    },
    [],
  )

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return
    setEdges((eds) => [
      ...eds,
      {
        id: newId(),
        source: connection.source!,
        target: connection.target!,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        type: 'smoothstep',
      },
    ])
  }, [])

  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean => {
      const source = connection.source
      const target = connection.target
      if (!source || !target) return false
      // Forbid self-connection and multiple incoming edges per target.
      return source !== target && !edges.some((e) => e.target === target)
    },
    [edges],
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const blockId = event.dataTransfer.getData('application/workflow-block')
      if (!blockId) return
      const block = BLOCK_BY_ID.get(blockId)
      if (!block) return
      const position = reactFlow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })
      const newNode: CustomNode = {
        id: newId(),
        type: 'custom',
        position,
        data: {
          blockId: block.id,
          values: defaultsFromParams(block.params),
        },
      }
      setNodes((nds) => [...nds, newNode])
    },
    [reactFlow],
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onNodesDelete = useCallback((deleted: Node[]) => {
    const ids = new Set(deleted.map((n) => n.id))
    setSelectedNodeId((current) => (current && ids.has(current) ? null : current))
  }, [])

  const handleSave = useCallback(async () => {
    if (!workflowId) return
    setSaving(true)
    setErrorBanner(null)
    try {
      const { x, y, zoom } = reactFlow.getViewport()
      const nodesWorkflow: WorkflowNode[] = nodes.map((n) => ({
        id: n.id,
        label: n.data.label || BLOCK_BY_ID.get(n.data.blockId)?.label || n.data.blockId,
        position: n.position,
        data: {
          blockId: n.data.blockId,
          values: n.data.values,
        },
      }))
      const edgesWorkflow: WorkflowEdge[] = edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
      }))
      const flowWorkflow: Workflow = {
        id: workflowId,
        name: workflowName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        drawflow: {
          nodes: nodesWorkflow,
          edges: edgesWorkflow,
          position: { x, y },
          zoom,
        },
        trigger,
        settings,
      }
      await sendCommand({ type: 'workflows.save', workflow: flowWorkflow })
      setLastSaved(new Date())
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [workflowId, workflowName, nodes, edges, trigger, settings, reactFlow])

  const handleRun = useCallback(async () => {
    if (!workflowId) return
    await handleSave()
    setRunning(true)
    setErrorBanner(null)
    try {
      const result = await sendCommand({ type: 'workflows.run', id: workflowId })
      if (result.type === 'workflows.run') {
        if (result.outcome.ok) {
          alert(`运行成功：${result.outcome.summary || '完成'}`)
        } else {
          alert(`运行失败：${result.outcome.error ?? result.outcome.summary}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorBanner(msg)
      alert(`运行出错：${msg}`)
    } finally {
      setRunning(false)
    }
  }, [workflowId, handleSave])

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId),
    [nodes, selectedNodeId],
  )

  const updateSelectedNodeValue = useCallback(
    (paramName: string, value: unknown) => {
      if (!selectedNodeId) return
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== selectedNodeId) return n
          return {
            ...n,
            data: {
              ...n.data,
              values: {
                ...n.data.values,
                [paramName]: value,
              },
            },
          }
        }),
      )
    },
    [selectedNodeId],
  )

  const updateSelectedNodeLabel = useCallback(
    (label: string) => {
      if (!selectedNodeId) return
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== selectedNodeId) return n
          return { ...n, data: { ...n.data, label } }
        }),
      )
    },
    [selectedNodeId],
  )

  const filteredBlocks = useMemo(() => {
    if (!searchText) return WORKFLOW_BLOCKS
    const q = searchText.toLowerCase()
    return WORKFLOW_BLOCKS.filter(
      (b) =>
        b.id.toLowerCase().includes(q) ||
        (b.label ?? '').toLowerCase().includes(q) ||
        (b.description ?? '').toLowerCase().includes(q),
    )
  }, [searchText])

  const blocksByCategory = useMemo(() => {
    const grouped = new Map<string, BlockDefinition[]>()
    for (const cat of BLOCK_CATEGORIES) grouped.set(cat, [])
    for (const block of filteredBlocks) {
      const list = grouped.get(block.category)
      if (list) list.push(block)
    }
    return Array.from(grouped.entries()).filter(([, blocks]) => blocks.length > 0)
  }, [filteredBlocks])

  // Only the *string contents* of node values can contribute a `{{var}}`.
  // Position changes (dragging) rebuild every node object but shouldn't force
  // a regex scan across the whole graph, so the memo keys off a compact
  // signature of those string values.
  const variableSignature = useMemo(() => {
    const parts: string[] = []
    for (const n of nodes) {
      const values = (n.data.values ?? {}) as Record<string, unknown>
      for (const v of Object.values(values)) {
        if (typeof v === 'string' && v.includes('{{')) parts.push(v)
      }
    }
    return parts.join('\u0000')
  }, [nodes])

  const availableVariables = useMemo(() => {
    const set = new Set<string>(BUILTIN_VARIABLES)
    VAR_TOKEN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = VAR_TOKEN.exec(variableSignature)) !== null) {
      const before = (m[1] ?? '').trim()
      if (before) set.add(before)
    }
    return Array.from(set)
  }, [variableSignature])

  /** Appends `{{varName}}` to a selected node's parameter value. */
  const insertVariableInto = useCallback(
    (paramName: string, varName: string): void => {
      if (!selectedNode) return
      const current = (selectedNode.data.values[paramName] as string | undefined) ?? ''
      updateSelectedNodeValue(paramName, `${current}{{${varName}}}`)
    },
    [selectedNode, updateSelectedNodeValue],
  )

  const triggerTypes: WorkflowTrigger['type'][] = [
    'manual',
    'scheduled',
    'context-menu',
    'visit-web',
    'github',
    'feishu',
  ]

  const selectedBlock = selectedNode ? BLOCK_BY_ID.get(selectedNode.data.blockId) : undefined

  return (
    <div className="editor-layout">
      <div className="editor-topbar">
        <div className="workflow-name">
          <input
            type="text"
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            placeholder="工作流名称"
          />
        </div>
        <div className={`save-status ${lastSaved && !saving ? 'saved' : ''}`}>
          {saving ? '保存中...' : lastSaved ? '已保存' : '未保存'}
        </div>
        <button className="primary" type="button" onClick={() => void handleSave()} disabled={saving || running}>
          保存
        </button>
        <button className="primary" type="button" onClick={() => void handleRun()} disabled={saving || running}>
          运行
        </button>
      </div>

      <div className="editor-palette">
        <div className="palette-search">
          <input
            type="text"
            placeholder="搜索节点..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>
        <div className="palette-categories">
          {blocksByCategory.map(([category, blocks]) => (
            <div key={category} className="palette-category">
              <h4>{CATEGORY_LABELS[category] ?? category}</h4>
              {blocks.map((block) => (
                <div
                  key={block.id}
                  className="palette-block"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/workflow-block', block.id)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  <div className="block-label">{block.label || block.id}</div>
                  {block.description && <div className="block-desc">{block.description}</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="editor-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          nodeTypes={nodeTypes}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onNodesDelete={onNodesDelete}
          fitView={!workflowId}
          deleteKeyCode="Delete"
          multiSelectionKeyCode="Control"
          defaultEdgeOptions={{ type: 'smoothstep' }}
        >
          <Background gap={16} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      <div className="editor-inspector">
        {errorBanner && (
          <div className="inspector-section error-banner">
            <h3>错误</h3>
            <div className="error-text">{errorBanner}</div>
          </div>
        )}

        <NodeInspector
          node={selectedNode}
          block={selectedBlock}
          values={selectedNode?.data.values ?? {}}
          availableVariables={availableVariables}
          onValueChange={updateSelectedNodeValue}
          onLabelChange={updateSelectedNodeLabel}
          onInsertVariable={insertVariableInto}
        />

        <div className="inspector-section">
          <h3>工作流变量</h3>
          <div className="param-desc" style={{ marginBottom: 8 }}>
            参数中可用 <code>{'{'}</code>{'{变量名}'}{'}'} 引用前面算子传递的变量；此处列出引擎内置变量与当前工作流中已出现的变量。
          </div>
          <div className="var-list">
            {availableVariables.length === 0 ? (
              <div className="inspector-empty">暂无变量</div>
            ) : (
              availableVariables.map((name) => (
                <span
                  key={name}
                  className="var-chip"
                  title="复制变量名"
                  onClick={() => void navigator.clipboard?.writeText(`{{${name}}}`)}
                >
                  {'{{'}
                  {name}
                  {'}}'}
                </span>
              ))
            )}
          </div>
        </div>

        {(!selectedNode || selectedBlock?.category === 'trigger') && (
        <div className="inspector-section">
          <h3>触发器设置</h3>
          <div className="param-group">
            <label>触发类型</label>
            <select
              value={trigger.type}
              onChange={(e) =>
                setTrigger({
                  type: e.target.value as WorkflowTrigger['type'],
                  enabled: trigger.enabled ?? true,
                })
              }
            >
              {triggerTypes.map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABELS[t] ?? t}
                </option>
              ))}
            </select>
          </div>

          <div className="param-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={trigger.enabled ?? false}
                onChange={(e) => setTrigger({ ...trigger, enabled: e.target.checked })}
              />
              启用触发器
            </label>
          </div>

          {trigger.type === 'scheduled' && (
            <div className="param-group">
              <label>时间表达式</label>
              <input
                type="text"
                value={trigger.schedule || ''}
                onChange={(e) => setTrigger({ ...trigger, schedule: e.target.value })}
                placeholder="0 8 * * * (每天 8 点)"
              />
              <div className="param-desc">Cron 表达式，与定时任务格式一致</div>
            </div>
          )}

          {trigger.type === 'visit-web' && (
            <div className="param-group">
              <label>URL 匹配</label>
              <input
                type="text"
                value={trigger.urlPattern || ''}
                onChange={(e) => setTrigger({ ...trigger, urlPattern: e.target.value })}
                placeholder="https://example.com/*"
              />
            </div>
          )}

          {trigger.type === 'context-menu' && (
            <div className="param-group">
              <label>菜单项 ID</label>
              <input
                type="text"
                value={trigger.menuItemId || ''}
                onChange={(e) => setTrigger({ ...trigger, menuItemId: e.target.value })}
                placeholder="留空自动使用工作流 ID"
              />
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
}