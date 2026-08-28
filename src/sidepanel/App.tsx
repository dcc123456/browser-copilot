import { useCallback, useEffect, useMemo, useState } from 'react'
import { effectiveLocale, messagesFor, type Messages } from '../lib/i18n'
import { sendCommand } from '../lib/messages'
import type { Skill } from '../lib/types'
import ChatTab from './ChatTab'
import DataTab from './DataTab'
import HistoryTab from './HistoryTab'
import { I18nProvider } from './i18n'
import SettingsTab from './SettingsTab'
import SkillsTab from './SkillsTab'
import TasksTab from './TasksTab'
import WorkflowsTab from './WorkflowsTab'
import { ConfirmHost } from '../ui/confirm'

type TabId = 'chat' | 'skills' | 'tasks' | 'workflows' | 'history' | 'data' | 'settings'

/** Always shown in the top bar. */
const PINNED_TABS: TabId[] = ['chat', 'workflows', 'history', 'tasks']
/** Collected under the fixed "More" dropdown. */
const MORE_TABS: TabId[] = ['skills', 'data', 'settings']

const TAB_LABEL: Record<TabId, keyof Messages> = {
  chat: 'tabChat',
  skills: 'tabSkills',
  tasks: 'tabTasks',
  workflows: 'tabWorkflows',
  history: 'tabHistory',
  data: 'tabData',
  settings: 'tabSettings',
}

export default function App() {
  const [active, setActive] = useState<TabId>('chat')
  // `null` until settings load, so the first paint uses the browser language
  // instead of flashing English at a Chinese user.
  const [localeSetting, setLocaleSetting] = useState<string | null>(null)

  /**
   * Skills are owned here, not by SkillsTab.
   *
   * Chat needs the list to populate its skill picker, and SkillsTab edits it.
   * Holding it at the shared parent means creating a skill shows up in Chat
   * immediately, without either tab reaching into the other.
   */
  const [skills, setSkills] = useState<Skill[]>([])
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null)

  const refreshSkills = useCallback(async () => {
    try {
      const result = await sendCommand({ type: 'skills.list' })
      if (result.type === 'skills.list') setSkills(result.skills ?? [])
    } catch {
      // Non-fatal: the Skills tab shows its own error when the user opens it.
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const result = await sendCommand({ type: 'settings.get' })
        if (result.type === 'settings') setLocaleSetting(result.settings.locale ?? 'auto')
      } catch {
        setLocaleSetting('auto')
      }
    })()
    void refreshSkills()
  }, [refreshSkills])

  const locale = effectiveLocale(
    (localeSetting ?? 'auto') as 'auto',
    navigator.language,
  )
  const i18n = useMemo(() => ({ locale, t: messagesFor(locale) }), [locale])

  // A deleted skill must not stay selected in Chat, or the turn would reference
  // instructions that no longer exist.
  useEffect(() => {
    if (activeSkillId && !skills.some((skill) => skill.id === activeSkillId)) {
      setActiveSkillId(null)
    }
  }, [skills, activeSkillId])

  // --- "More" dropdown menu ------------------------------------------------
  const [moreOpen, setMoreOpen] = useState(false)

  // Close the "More" menu when clicking outside.
  useEffect(() => {
    if (!moreOpen) return
    const onDown = (): void => setMoreOpen(false)
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [moreOpen])

  // History tab dispatches `bc:open-conversation` when the user clicks
  // "continue chat" on a past conversation. Switch to the Chat tab and let
  // ChatTab's own listener do the resume.
  useEffect(() => {
    const handler = (): void => setActive('chat')
    window.addEventListener('bc:open-conversation', handler)
    return () => window.removeEventListener('bc:open-conversation', handler)
  }, [])

  // Other tabs (e.g. the Workflows tab's failed-run banner) dispatch
  // `bc:open-history` to deep-link into the History tab. HistoryTab itself
  // listens for the detail payload (section + run id to expand); App only
  // needs to flip the active tab.
  useEffect(() => {
    const handler = (): void => setActive('history')
    window.addEventListener('bc:open-history', handler)
    return () => window.removeEventListener('bc:open-history', handler)
  }, [])

  return (
    <I18nProvider value={i18n}>
      <nav className="tabs">
        {PINNED_TABS.map((id) => (
          <button
            key={id}
            className="tab"
            data-active={active === id}
            onClick={() => setActive(id)}
            type="button"
          >
            {i18n.t[TAB_LABEL[id]] as string}
          </button>
        ))}
        <div className="tab-more-wrap">
          <button
            className="tab tab-more"
            data-active={MORE_TABS.includes(active)}
            onClick={(e) => {
              e.stopPropagation()
              setMoreOpen((v) => !v)
            }}
            type="button"
          >
            {i18n.t.tabMore}
            <span className="tab-more-caret">▾</span>
          </button>
          {moreOpen && (
            <div className="tab-more-menu" onMouseDown={(e) => e.stopPropagation()}>
              {MORE_TABS.map((id) => (
                <button
                  key={id}
                  className="tab-more-item"
                  data-active={active === id}
                  onClick={() => {
                    setActive(id)
                    setMoreOpen(false)
                  }}
                  type="button"
                >
                  {i18n.t[TAB_LABEL[id]] as string}
                </button>
              ))}
            </div>
          )}
        </div>
      </nav>
      {/*
        Every tab stays mounted: the chat holds a live port and streaming
        transcript that must survive the user editing a skill mid-answer.
      */}
      <div style={{ display: active === 'chat' ? 'contents' : 'none' }}>
        <ChatTab
          skills={skills}
          activeSkillId={activeSkillId}
          onSelectSkill={setActiveSkillId}
        />
      </div>
      <div style={{ display: active === 'skills' ? 'contents' : 'none' }}>
        <SkillsTab
          skills={skills}
          activeSkillId={activeSkillId}
          onChanged={refreshSkills}
          onUseInChat={(id) => {
            setActiveSkillId(id)
            // Only jump to Chat when a skill was chosen; clearing should leave the
            // user where they are.
            if (id) setActive('chat')
          }}
        />
      </div>
      <div style={{ display: active === 'tasks' ? 'contents' : 'none' }}>
        <TasksTab />
      </div>
      <div style={{ display: active === 'workflows' ? 'contents' : 'none' }}>
        <WorkflowsTab />
      </div>
      <div style={{ display: active === 'history' ? 'contents' : 'none' }}>
        <HistoryTab />
      </div>
      <div style={{ display: active === 'data' ? 'contents' : 'none' }}>
        <DataTab />
      </div>
      <div style={{ display: active === 'settings' ? 'contents' : 'none' }}>
        <SettingsTab onLocaleChange={setLocaleSetting} />
      </div>
      {/* Shared custom confirm/alert dialog host (replaces window.confirm). */}
      <ConfirmHost />
    </I18nProvider>
  )
}
