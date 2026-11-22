// Design tokens of the dashboard. Build the stylesheet with: npm run build:admin
module.exports = {
  content: ['./src/public/admin/**/*.js', './src/public/admin/console.html', './src/admin/shell.html'],
  safelist: [{ pattern: /^(bg|text)-(success|warning|danger|accent)(-soft|-text)?$/ }],
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
            mono: ['JetBrains Mono', 'monospace'],
          },
          colors: {
            canvas: 'var(--bg-canvas)',
            surface: 'var(--bg-surface)',
            elevated: 'var(--bg-elevated)',
            subtle: 'var(--bg-subtle)',
            ink: {
              primary: 'var(--text-primary)',
              secondary: 'var(--text-secondary)',
              muted: 'var(--text-muted)',
            },
            line: {
              subtle: 'var(--border-subtle)',
              strong: 'var(--border-strong)',
            },
            accent: {
              DEFAULT: 'var(--accent-primary)',
              hover: 'var(--accent-hover)',
              soft: 'var(--accent-soft)',
              text: 'var(--accent-text)',
            },
            success: {
              DEFAULT: 'var(--status-success)',
              soft: 'var(--status-success-soft)',
              text: 'var(--status-success-text)',
            },
            warning: {
              DEFAULT: 'var(--status-warning)',
              soft: 'var(--status-warning-soft)',
              text: 'var(--status-warning-text)',
            },
            danger: {
              DEFAULT: 'var(--status-danger)',
              soft: 'var(--status-danger-soft)',
              text: 'var(--status-danger-text)',
            },
          },
          borderRadius: {
            sm: 'var(--radius-sm)',
            md: 'var(--radius-md)',
            lg: 'var(--radius-lg)',
            xl: 'var(--radius-xl)',
            pill: 'var(--radius-pill)',
          },
          boxShadow: {
            xs: 'var(--shadow-xs)',
            sm: 'var(--shadow-sm)',
            md: 'var(--shadow-md)',
            lg: 'var(--shadow-lg)',
            glow: 'var(--shadow-glow)',
          }
        }
      }
    };
