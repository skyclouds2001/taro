import { Current, document, requestAnimationFrame, TaroElement, window } from '@tarojs/runtime' // eslint-disable-line import/no-duplicates
import { CONTEXT_ACTIONS, env, eventCenter, TFunc } from '@tarojs/runtime/dist/runtime.esm' // eslint-disable-line import/no-duplicates
import { ensure, hooks, isUndefined } from '@tarojs/shared'

import { ReactMeta as reactMeta } from './app'
import { setReconciler } from './connect'
import { ON_HIDE, ON_READY, ON_SHOW } from './constant'
import {
  addLeadingSlash,
  getOnHideEventKey,
  getOnReadyEventKey,
  getOnShowEventKey, 
  getPath,
  injectPageInstance,
  removePageInstance,
  safeExecute
} from './page'
import { EMPTY_OBJ, incrementId, isClassComponent } from './utils'

import type { AppInstance } from '@tarojs/taro'
import type * as React from 'react'

const getNativeCompId = incrementId()
let h: typeof React.createElement
let ReactDOM
let nativeComponentApp: AppInstance
interface InitNativeComponentEntryParams {
  R: typeof React
  ReactDOM: typeof ReactDOM
  cb?: TFunc
  // 是否使用默认的 DOM 入口 - app；默认为true，false的时候，会创建一个新的dom并且把它挂载在 app 下面
  isDefaultEntryDom?: boolean
}

function initNativeComponentEntry (params: InitNativeComponentEntryParams) {
  const { R, ReactDOM, cb, isDefaultEntryDom = true } = params
  interface IEntryState {
    components: {
      compId: string
      element: React.ReactElement
    }[]
  }

  interface IWrapperProps {
    compId: string
    getCtx: () => any
    renderComponent: (ctx: any) => React.ReactElement
  }

  class NativeComponentWrapper extends R.Component<IWrapperProps, Record<any, any>> {
    root = R.createRef<TaroElement>()
    ctx = this.props.getCtx()

    componentDidMount () {
      this.ctx.component = this
      const rootElement = this.root.current!
      rootElement.ctx = this.ctx
      // TODO: performUpdate
      // rootElement.performUpdate(true)
    }

    render () {
      return (
        h(
          'view',
          {
            ref: this.root,
            id: this.props.compId
          },
          this.props.renderComponent(this.ctx)
        )
      )
    }
  }

  class Entry extends R.Component<Record<any, any>, IEntryState> {
    state: IEntryState = {
      components: []
    }

    componentDidMount () {
      if (isDefaultEntryDom) {
        if (Current.app) {
          Current.app = Object.assign(this, Current.app)
        } else {
          Current.app = this
        }
      } else {
        nativeComponentApp = this
      }
      cb && cb()
    }

    mount (Component, compId, getCtx, cb?) {
      const isReactComponent = isClassComponent(R, Component)
      const inject = (node?: any) => node && injectPageInstance(node, compId)
      const refs = isReactComponent ? { ref: inject } : {
        forwardedRef: inject,
        reactReduxForwardedRef: inject
      }
      if (reactMeta.PageContext === EMPTY_OBJ) {
        reactMeta.PageContext = R.createContext('')
      }
      const item = {
        compId,
        element: h(NativeComponentWrapper, {
          key: compId,
          compId,
          getCtx,
          renderComponent (ctx) {
            return h(
              reactMeta.PageContext.Provider,
              { value: compId },
              h(
                Component,
                {
                  // TODO: 传递 Props
                  ...(ctx.props || {}),
                  ...refs,
                  $scope: ctx
                }
              )
            )
          }
        })
      }
      this.setState({
        components: [...this.state.components, item]
      }, () => cb && cb())
    }

    unmount (compId, cb?) {
      const components = this.state.components
      const index = components.findIndex(item => item.compId === compId)
      const next = [...components.slice(0, index), ...components.slice(index + 1)]
      this.setState({
        components: next
      }, () => {
        removePageInstance(compId)
        cb && cb()
      })
    }

    render () {
      const components = this.state.components

      return (
        components.map(({ element }) => element)
      )
    }
  }

  setReconciler(ReactDOM)

  let app = document.getElementById('app')
  if (!isDefaultEntryDom && !nativeComponentApp) {
    // create
    const nativeApp = document.createElement('nativeComponent')
    // insert
    app.appendChild(nativeApp)
    app = nativeApp
  }
  // eslint-disable-next-line react/no-deprecated
  ReactDOM.render(
    h(Entry, {}),
    app
  )
}

export function createNativePageConfig (Component, pageName: string, react: typeof React, reactDOM: typeof ReactDOM, pageConfig) {
  reactMeta.R = react
  h = react.createElement
  ReactDOM = reactDOM
  setReconciler(ReactDOM)
  const [
    ONLOAD,
    ONUNLOAD,
    ONREADY,
    ONSHOW,
    ONHIDE,
    LIFECYCLES,
    SIDE_EFFECT_LIFECYCLES
  ] = hooks.call('getMiniLifecycleImpl')!.page
  let unmounting = false
  let prepareMountList: (() => void)[] = []
  let pageElement: TaroElement | null = null
  let loadResolver: (...args: unknown[]) => void
  let hasLoaded: Promise<void>
  const id = pageName ?? `taro_page_${getNativeCompId()}`
  function setCurrentRouter (page) {
    const router = page.route || page.__route__ || page.$taroPath
    Current.router = {
      params: page.$taroParams!,
      path: addLeadingSlash(router),
      $taroPath: page.$taroPath,
      onReady: getOnReadyEventKey(id),
      onShow: getOnShowEventKey(id),
      onHide: getOnHideEventKey(id)
    }
    if (!isUndefined(page.exitState)) {
      Current.router.exitState = page.exitState
    }
  }

  const pageObj: Record<string, any> = {
    options: pageConfig,
    [ONLOAD] (options: Readonly<Record<string, unknown>> = {}, cb?: TFunc) {
      hasLoaded = new Promise(resolve => { loadResolver = resolve })
      Current.page = this as any
      this.config = pageConfig || {}
      // this.$taroPath 是页面唯一标识
      const uniqueOptions = Object.assign({}, options, { $taroTimestamp: Date.now() })
      const $taroPath = this.$taroPath = getPath(id, uniqueOptions)

      // this.$taroParams 作为暴露给开发者的页面参数对象，可以被随意修改
      if (this.$taroParams == null) {
        this.$taroParams = uniqueOptions
      }

      setCurrentRouter(this)
      window.trigger(CONTEXT_ACTIONS.INIT, $taroPath)

      const mountCallback = () => {
        pageElement = document.getElementById($taroPath)

        ensure(pageElement !== null, '没有找到页面实例。')

        safeExecute($taroPath, ONLOAD, this.$taroParams)
        loadResolver()
        cb && cb(pageElement)
        pageElement.ctx = this
      }

      const mount = () => {
        if (!Current.app) {
          initNativeComponentEntry({
            R: react,
            ReactDOM,
            cb: () => {
              Current.app!.mount!(Component, $taroPath, () => this, mountCallback)
            }
          })
        } else {
          Current.app!.mount!(Component, $taroPath, () => this, mountCallback)
        }
      }

      if (unmounting) {
        prepareMountList.push(mount)
      } else {
        mount()
      }
    },
    [ONUNLOAD] () {
      const $taroPath = this.$taroPath
      // 销毁当前页面的上下文信息
      window.trigger(CONTEXT_ACTIONS.DESTORY, $taroPath)
      // 触发onUnload生命周期
      safeExecute($taroPath, ONUNLOAD)
      resetCurrent()
      unmounting = true
      Current.app!.unmount!($taroPath, () => {
        unmounting = false
        removePageInstance($taroPath)
        if (pageElement) {
          pageElement.ctx = null
          pageElement = null
        }
        if (prepareMountList.length) {
          prepareMountList.forEach(fn => fn())
          prepareMountList = []
        }
      })
    },
    [ONREADY] () {
      hasLoaded.then(() => {
        // 触发生命周期
        safeExecute(this.$taroPath, ON_READY)
        // 通过事件触发子组件的生命周期
        requestAnimationFrame(() => eventCenter.trigger(getOnReadyEventKey(id)))
        this.onReady.called = true
      })
    },
    [ONSHOW] (options = {}) {
      hasLoaded.then(() => {
        // 设置 Current 的 page 和 router
        Current.page = this as any
        setCurrentRouter(this)
        // 恢复上下文信息
        window.trigger(CONTEXT_ACTIONS.RECOVER, this.$taroPath)
        // 触发生命周期
        safeExecute(this.$taroPath, ON_SHOW, options)
        // 通过事件触发子组件的生命周期
        requestAnimationFrame(() => eventCenter.trigger(getOnShowEventKey(id)))
      })
    },
    [ONHIDE] () {
      // 缓存当前页面上下文信息
      window.trigger(CONTEXT_ACTIONS.RESTORE, this.$taroPath)
      // 设置 Current 的 page 和 router
      if (Current.page === this) {
        Current.page = null
        Current.router = null
      }
      // 触发生命周期
      safeExecute(this.$taroPath, ON_HIDE)
      // 通过事件触发子组件的生命周期
      eventCenter.trigger(getOnHideEventKey(id))
    },
  }

  function resetCurrent () {
    // 小程序插件页面卸载之后返回到宿主页面时，需重置Current页面和路由。否则引发插件组件二次加载异常 fix:#11991
    Current.page = null
    Current.router = null
  }


  LIFECYCLES.forEach((lifecycle) => {
    pageObj[lifecycle] = function () {
      return safeExecute(this.$taroPath, lifecycle, ...arguments)
    }
  })

  // onShareAppMessage 和 onShareTimeline 一样，会影响小程序右上方按钮的选项，因此不能默认注册。
  SIDE_EFFECT_LIFECYCLES.forEach(lifecycle => {
    if (Component[lifecycle] ||
      Component.prototype?.[lifecycle] ||
      Component[lifecycle.replace(/^on/, 'enable')]
    ) {
      pageObj[lifecycle] = function (...args) {
        const target = args[0]?.target
        if (target?.id) {
          const id = target.id
          const element = env.document.getElementById(id)
          if (element) {
            target.dataset = element.dataset
          }
        }
        return safeExecute(this.$taroPath, lifecycle, ...args)
      }
    }
  })

  hooks.call('modifyPageObject', pageObj)

  return pageObj
}
