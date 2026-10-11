/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // B 站品牌粉
        bilibili: {
          DEFAULT: '#FB7299',
          soft: '#FFF0F5',
          deep: '#E85A80',
        },
        ink: {
          900: '#111318',
          700: '#2C2F38',
          500: '#5A6070',
          300: '#9AA0AE',
          100: '#E8EAF0',
        },
      },
      fontFamily: {
        sans: [
          '"PingFang SC"', '"Microsoft YaHei"', '"Hiragino Sans GB"',
          'system-ui', '-apple-system', 'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 3px rgba(17,19,24,0.06), 0 8px 24px -12px rgba(17,19,24,0.16)',
        lifted: '0 4px 12px rgba(17,19,24,0.08), 0 18px 40px -16px rgba(17,19,24,0.22)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pop-in': {
          '0%': { opacity: '0', transform: 'scale(0.94)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.42s cubic-bezier(0.22,1,0.36,1) both',
        'pop-in': 'pop-in 0.24s cubic-bezier(0.34,1.56,0.64,1) both',
      },
    },
  },
  plugins: [],
}
