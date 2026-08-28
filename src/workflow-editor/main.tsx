import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import 'remixicon/fonts/remixicon.css'
import EditorApp from './App'
import '../ui/design-system.css'
import './styles.css'
import './theme.css'

const container = document.getElementById('root')
if (!container) throw new Error('Editor root element is missing.')

createRoot(container).render(
  <StrictMode>
    <ReactFlowProvider>
      <EditorApp />
    </ReactFlowProvider>
  </StrictMode>,
)