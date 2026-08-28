import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import '../ui/design-system.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Side panel root element is missing.')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
