import { useCallback, useEffect, useMemo, useState } from 'react'
import { effectiveLocale, messagesFor, type Messages } from '../lib/i18n'
import { sendCommand } from '../lib/messages'
import type { Skill } from '../lib/types'
import ChatTab from './ChatTab'
import DataTab from './DataTab'
import { I18nProvider } from './i18n'
import SettingsTab from './SettingsTab'
import SkillsTab from './SkillsTab'
import TasksTab from './TasksTab'

type TabId = 'chat' | 'skills' | 'tasks' | 'data' | 'settings'

const TAB_ORDER: TabId[] = ['chat', 'skills', 'tasks', 'data', 'settings']

const TAB_LABEL: Record<TabId, keyof Messages> = {
  chat: 'tabChat',
  skills: 'tabSkills',
  tasks: 'tabTasks',
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

  return (
    <I18nProvider value={i18n}>
      <nav className="tabs">
        {TAB_ORDER.map((id) => (
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
      <div style={{ display: active === 'data' ? 'contents' : 'none' }}>
        <DataTab />
      </div>
      <div style={{ display: active === 'settings' ? 'contents' : 'none' }}>
        <SettingsTab onLocaleChange={setLocaleSetting} />
      </div>
    </I18nProvider>
  )
}
