// React implementation of the shared matrix UI contract: a "Your name" input, a
// "Greet" button, and a #status line. Deliberately uses a CONTROLLED input (value +
// onChange) and React's synthetic onClick, so driving it proves the tools work through
// React's virtual DOM and event system — not just against static markup. Bundled to a
// self-contained IIFE by build-fixtures.mjs (esbuild), loaded by index.html.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'

function App() {
  const [name, setName] = useState('')
  const [status, setStatus] = useState('No greeting yet')

  const greet = () => {
    const who = name.trim() || 'stranger'
    setStatus(`Hello, ${who}!`)
    console.log(`greeted ${who}`)
  }

  return (
    <main>
      <h1>React fixture</h1>
      <label>
        Your name
        <input
          id="name"
          type="text"
          aria-label="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button id="greet" type="button" onClick={greet}>
        Greet
      </button>
      <p id="status">{status}</p>
    </main>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
