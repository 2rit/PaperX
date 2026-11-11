/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['"IBM Plex Sans Thai"', 'system-ui', 'sans-serif'] },
      colors: {
        ink: { DEFAULT: '#1c1f22', 900: '#16181b', 800: '#1f2226', 700: '#2a2e33', 600: '#3a3f45' },
        lime: { DEFAULT: '#8ee04a', 50: '#f3fce9', 100: '#e4f8cf', 200: '#c9f0a0', 300: '#aee873', 400: '#9be35b', 500: '#86d63f', 600: '#6cb92b', 700: '#529122' },
        paper: { DEFAULT: '#f4f5f2', 100: '#fafbf8', 200: '#eef0eb', 300: '#e2e5de' },
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,16,.06), 0 6px 20px -8px rgba(16,24,16,.14)',
        lime: '0 6px 18px -6px rgba(134,214,63,.65)',
      },
      borderRadius: { xl2: '1.15rem' },
      keyframes: {
        fadeUp: { '0%': { opacity: 0, transform: 'translateY(10px)' }, '100%': { opacity: 1, transform: 'none' } },
        fadeIn: { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        sheetUp: { '0%': { transform: 'translateY(100%)' }, '100%': { transform: 'none' } },
        pop: { '0%': { transform: 'scale(.6)', opacity: 0 }, '70%': { transform: 'scale(1.08)' }, '100%': { transform: 'scale(1)', opacity: 1 } },
        flash: { '0%': { opacity: 0.92 }, '100%': { opacity: 0 } },
        flythumb: {
          '0%': { left: '50%', top: '42%', transform: 'translate(-50%, -50%) scale(1)', opacity: '1' },
          '100%': { left: '16%', top: '88%', transform: 'translate(-50%, -50%) scale(0.22)', opacity: '0.95' },
        },
        shimmer: { '0%': { backgroundPosition: '-400px 0' }, '100%': { backgroundPosition: '400px 0' } },
        pulseRing: { '0%': { boxShadow: '0 0 0 0 rgba(142,224,74,.55)' }, '100%': { boxShadow: '0 0 0 14px rgba(142,224,74,0)' } },
      },
      animation: {
        fadeUp: 'fadeUp .28s cubic-bezier(.2,.8,.2,1) both',
        fadeIn: 'fadeIn .2s ease both',
        sheetUp: 'sheetUp .3s cubic-bezier(.2,.8,.2,1) both',
        pop: 'pop .35s cubic-bezier(.2,.8,.2,1) both',
        flash: 'flash .4s ease-out both',
        flythumb: 'flythumb .6s cubic-bezier(.2,.7,.2,1) forwards',
        shimmer: 'shimmer 1.3s linear infinite',
        pulseRing: 'pulseRing 1.2s ease-out infinite',
      },
    },
  },
  plugins: [],
};
