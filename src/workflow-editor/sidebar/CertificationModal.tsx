/**
 * Certification evidence modal — renders the L1/L2/L3 VerificationReport
 * after a run. Shows which level passed/failed and the per-condition evidence,
 * so a last-node-success-but-goal-fail result reads clearly.
 */
import { CheckCircle2, CircleSlash, XCircle } from 'lucide-react'
import type { VerificationReport, ConditionEvidence } from '../../background/workflow-engine/goal-verification'
import Modal from '../ui/Modal'
import type { TranslateFn } from '../i18n'
function EvidenceList({ items }: { items: ConditionEvidence[] }) {
  if (items.length === 0) return null
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-1.5 text-xs text-muted">
          {item.satisfied ? <CheckCircle2 size={12} className="mt-px text-accent" /> : <XCircle size={12} className="mt-px text-err" />}
          <span>{item.description}</span>
          {item.detail && <span className="text-[11px] text-muted">— {item.detail}</span>}
        </li>
      ))}
    </ul>
  )
}
/** Structured certification evidence (portal-free, server-renderable). */
export function CertificationEvidence({ report, t }: { report: VerificationReport; t: TranslateFn }) {
  return (
    <div className="flex flex-col gap-3">
      <div className={`flex items-center gap-2 rounded-lg border p-2.5 ${report.certified ? 'border-border bg-accent-soft text-accent' : 'border-border bg-panel text-err'}`}>
        {report.certified ? <CheckCircle2 size={16} /> : <CircleSlash size={16} />}
        <span className="text-sm font-semibold">{report.reason}</span>
      </div>
      <section>
        <h4 className="mb-1 text-xs font-semibold text-strong">{t('certLevelL1')}</h4>
        <EvidenceList items={report.l1} />
      </section>
      <section>
        <h4 className="mb-1 text-xs font-semibold text-strong">{t('certLevelL2')}</h4>
        {report.l2.nodes.flatMap((n) => [...n.criteria, ...n.preconditions]).length === 0 ? (
          <p className="text-xs text-muted">{t('certNoNodeContracts')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {report.l2.nodes.filter((n) => n.criteria.length + n.preconditions.length > 0).map((n) => (
              <div key={n.nodeId} className="rounded-lg border border-border bg-panel p-2">
                <p className="mb-1 text-[11px] font-medium text-strong">{n.blockId}</p>
                <EvidenceList items={[...n.criteria, ...n.preconditions]} />
              </div>
            ))}
          </div>
        )}
      </section>
      <section>
        <h4 className="mb-1 text-xs font-semibold text-strong">{t('certLevelL3')}</h4>
        {report.l3.goalSummary && <p className="mb-1 text-xs text-muted">{report.l3.goalSummary}</p>}
        <EvidenceList items={report.l3.conditions} />
      </section>
    </div>
  )
}

export default function CertificationModal({ report, onClose, t }: { report: VerificationReport | null; onClose: () => void; t: TranslateFn }) {
  return (
    <Modal open={!!report} onClose={onClose} title={t('certificationTitle')} size="md">
      {report && <CertificationEvidence report={report} t={t} />}
    </Modal>
  )
}