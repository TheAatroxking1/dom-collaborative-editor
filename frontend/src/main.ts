import { createApp } from 'vue'

import App from './App.vue'
import { registerOfflineShell } from './offline'
import './styles.css'

// 先注册页面外壳缓存，再挂载应用：缓存不可用不应影响编辑器加载，
// 它只是让「整站断网后刷新」能打开页面这一项能力。
registerOfflineShell()

createApp(App).mount('#app')
