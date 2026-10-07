import './globals.css';
import './auth.css';

export const metadata = {
  title: 'L’atelier — Collectif design',
  description: 'Espace de travail du collectif design.',
};

export default function RootLayout({ children }) {
  return <html lang="fr"><body>{children}</body></html>;
}
