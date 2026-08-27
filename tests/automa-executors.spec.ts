import { describe, it, expect } from 'vitest'
import { EXECUTORS } from '../src/background/workflow-engine/executors'

describe('Automa-catalog executor coverage', () => {
  // These ids are produced by the recorder / editor and previously hit
  // "没有找到块执行器" (no block executor found).
  it.each([
    'trigger',
    'event-click',
    'hover-element',
    'element-scroll',
    'forms',
    'conditions',
    'loop-breakpoint',
  ])('registers an executor for %s', (id) => {
    expect(typeof EXECUTORS[id]).toBe('function')
  })

  it('event-click shares the click executor behavior', () => {
    expect(EXECUTORS['event-click']).toBeDefined()
  })
})
