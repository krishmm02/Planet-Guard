/** /home predates the game; send anyone landing here straight to it. */
import { Navigate } from 'react-router-dom'

export default function HomePage() {
  return <Navigate to="/play" replace />
}
