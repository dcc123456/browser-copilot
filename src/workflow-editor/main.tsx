import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import EditorApp from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Editor root element is missing.')

createRoot(container).render(
  <StrictMode>
    <ReactFlowProvider>
      <EditorApp />
    </ReactFlowProvider>
  </StrictMode>,
)