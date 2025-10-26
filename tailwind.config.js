module.exports = {
content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
theme: {
extend: {
keyframes: {
fall: {
'0%': { transform: 'translateY(-20px) rotate(-5deg)', opacity: '1' },
'100%': { transform: 'translateY(400px) rotate(25deg)', opacity: '0' }
}
},
animation: {
fall: 'fall 800ms ease-in forwards'
}
}
},
plugins: [],
}
