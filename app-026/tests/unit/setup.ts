import 'fake-indexeddb/auto'

// React act() 环境标记（jsdom 下组件测试需要）
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
