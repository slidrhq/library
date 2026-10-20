import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerLibraryFonts } from './fontFaces';
import { I18n } from './i18n';
import { Shell } from './Shell';
import './styles.css';
import './library.css';

// The designs and the fonts' samples are drawn in the library's fonts, as the app draws them.
void registerLibraryFonts().catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18n>
      <Shell />
    </I18n>
  </StrictMode>,
);
