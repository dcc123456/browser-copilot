/**
 * Executable probes for the advertised `javascript-code` helpers.
 *
 * Shared by the page-harness and local-fallback contract tests. Every probe is
 * a statement body ending in `automaNextBlock`, so it runs unchanged through
 * the injected kernel harness and the two local `new Function` fallbacks.
 * The `Record` key must equal the advertised helper name — the contract tests
 * fail when a catalogue entry has no probe.
 */

export interface CodeNodeHelperProbe {
  code: string
  /** Variables the block starts with. */
  variables?: Record<string, unknown>
  expectedResult: unknown
  expectedVariables?: Record<string, unknown>
}

export const CODE_NODE_HELPER_PROBES: Record<string, CodeNodeHelperProbe> = {
  automaNextBlock: {
    code: 'automaNextBlock({ answer: 6 * 7 })',
    expectedResult: { answer: 42 },
  },
  automaSetVariable: {
    code: "automaSetVariable('helped', 7); automaNextBlock()",
    expectedResult: undefined,
    expectedVariables: { helped: 7 },
  },
  automaRefData: {
    code: "automaSetVariable('obj', { deep: 5 }); automaNextBlock([automaRefData('variables', 'obj.deep'), automaRefData('table', '0.name')])",
    variables: { dataTable: [{ name: 'row-1' }] },
    expectedResult: [5, 'row-1'],
  },
  automaResetTimeout: {
    code: "automaResetTimeout(); automaNextBlock('rearmed')",
    expectedResult: 'rearmed',
  },
  variables: {
    code: 'variables.answer = 42; automaNextBlock(variables.answer)',
    expectedResult: 42,
    expectedVariables: { answer: 42 },
  },
}
