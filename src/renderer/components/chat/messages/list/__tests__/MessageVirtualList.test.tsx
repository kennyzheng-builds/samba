import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Activity } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageVirtualList } from '../MessageVirtualList'
import { useScrollRuntimeBoundary } from '../ScrollOwnershipContext'

const runtimeMockState = vi.hoisted(() => ({
  isScrollToBottomButtonVisible: false,
  takeUserControl: vi.fn(),
  scrollToBottom: vi.fn(),
  scrollToTop: vi.fn(),
  notifyWheelIntent: vi.fn(),
  scrollByWheel: vi.fn(() => true),
  // jsdom leaves `scrollBy` unimplemented, so the runtime stand-in applies the
  // delta itself and the viewport outcome stays observable in these tests.
  scrollByOffset: vi.fn((deltaY: number) => {
    const scroller = runtimeMockState.scrollerRef.current
    if (scroller) scroller.scrollTop += deltaY
    return true
  }),
  markUserInput: vi.fn(),
  beginScrollbarDrag: vi.fn(),
  endScrollbarDrag: vi.fn(),
  onWheel: vi.fn(),
  shift: false,
  scrollerRef: { current: null as HTMLDivElement | null }
}))

const virtuaMockState = vi.hoisted(() => ({
  scrollRefReadyAtMount: [] as boolean[]
}))

vi.mock('@cherrystudio/ui', () => {
  return {
    Button: ({ children, size, variant, ...props }: any) => {
      void size
      void variant
      return (
        <button type={props.type ?? 'button'} {...props}>
          {children}
        </button>
      )
    },
    Scrollbar: ({ ref, children, ...props }: any) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    ),
    Tooltip: ({ children }: any) => <>{children}</>
  }
})

vi.mock('lucide-react', () => {
  return {
    ArrowDown: () => <svg data-testid="scroll-arrow-icon" />
  }
})

vi.mock('react-i18next', () => {
  return {
    useTranslation: () => ({
      t: (key: string) => key
    })
  }
})

vi.mock('virtua', () => {
  return {
    Virtualizer: ({ ref, scrollRef, children, data, shift, startMargin }: any) => {
      virtuaMockState.scrollRefReadyAtMount.push(Boolean(scrollRef.current))
      return (
        <div ref={ref} data-shift={String(shift)} data-start-margin={startMargin} data-testid="virtualizer">
          {data.map((item: unknown, index: number) => (
            <div key={index}>{children(item, index)}</div>
          ))}
        </div>
      )
    }
  }
})

vi.mock('../chatVirtualizerRuntime', async () => {
  const { createElement } = await import('react')
  return {
    useChatVirtualizerRuntime: vi.fn(({ items, renderItem }) => ({
      contentRef: { current: null },
      freezeSpacerRef: { current: null },
      keepMounted: [],
      scrollerProps: {
        onScroll: vi.fn(),
        onScrollEnd: vi.fn(),
        onWheel: runtimeMockState.onWheel
      },
      scrollerRef: runtimeMockState.scrollerRef,
      vlistHandleRef: { current: null },
      isScrollToBottomButtonVisible: runtimeMockState.isScrollToBottomButtonVisible,
      takeUserControl: runtimeMockState.takeUserControl,
      scrollToBottom: runtimeMockState.scrollToBottom,
      scrollToTop: runtimeMockState.scrollToTop,
      notifyWheelIntent: runtimeMockState.notifyWheelIntent,
      scrollByWheel: runtimeMockState.scrollByWheel,
      scrollByOffset: runtimeMockState.scrollByOffset,
      markUserInput: runtimeMockState.markUserInput,
      beginScrollbarDrag: runtimeMockState.beginScrollbarDrag,
      endScrollbarDrag: runtimeMockState.endScrollbarDrag,
      shift: runtimeMockState.shift,
      wrappedItems: items,
      wrappedRenderItem: (item: unknown, index: number) =>
        createElement('div', { 'data-testid': `item-${index}` }, renderItem(item, index))
    }))
  }
})

function ScrollRuntimeBoundaryProbe() {
  const runtime = useScrollRuntimeBoundary()
  return (
    <>
      <button type="button" onClick={() => runtime.notifyWheelIntent(40)}>
        notify wheel
      </button>
      <button type="button" onClick={() => runtime.scrollByWheel(80)}>
        scroll by wheel
      </button>
    </>
  )
}

describe('MessageVirtualList', () => {
  beforeEach(() => {
    runtimeMockState.isScrollToBottomButtonVisible = false
    runtimeMockState.takeUserControl.mockClear()
    runtimeMockState.scrollToBottom.mockClear()
    runtimeMockState.scrollToTop.mockClear()
    runtimeMockState.notifyWheelIntent.mockClear()
    runtimeMockState.scrollByWheel.mockClear()
    runtimeMockState.scrollByOffset.mockClear()
    runtimeMockState.markUserInput.mockClear()
    runtimeMockState.beginScrollbarDrag.mockClear()
    runtimeMockState.endScrollbarDrag.mockClear()
    runtimeMockState.onWheel.mockClear()
    runtimeMockState.shift = false
    runtimeMockState.scrollerRef.current = null
    virtuaMockState.scrollRefReadyAtMount.length = 0
  })

  it('mounts virtua only after the external scroller ref is ready', () => {
    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={(item) => <span>{item}</span>}
      />
    )

    expect(screen.getByTestId('virtualizer')).toBeInTheDocument()
    expect(virtuaMockState.scrollRefReadyAtMount).not.toContain(false)
    expect(virtuaMockState.scrollRefReadyAtMount.length).toBeGreaterThan(0)
  })

  it('keeps virtua mounted when a hidden tab detaches the scroller ref', () => {
    const TabbedList = ({ visible }: { visible: boolean }) => (
      <Activity mode={visible ? 'visible' : 'hidden'}>
        <MessageVirtualList
          items={['message-1']}
          getItemKey={(item) => item}
          renderItem={(item) => <span>{item}</span>}
        />
      </Activity>
    )

    const { rerender } = render(<TabbedList visible />)
    const virtualizerAtMount = screen.getByTestId('virtualizer')

    rerender(<TabbedList visible={false} />)
    rerender(<TabbedList visible />)

    // A remount would rebuild virtua from estimated sizes and drop every
    // message's own state, so the node identity must survive the round trip.
    expect(screen.getByTestId('virtualizer')).toBe(virtualizerAtMount)
    expect(runtimeMockState.scrollerRef.current).not.toBeNull()
  })

  it('renders the top padding as real scroll content before the virtualizer', () => {
    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={(item) => <span>{item}</span>}
        topPadding={44}
      />
    )

    const spacer = document.querySelector('[data-message-virtual-list-top-spacer]')
    expect(spacer).toHaveStyle({ height: '44px' })
    expect(spacer?.nextElementSibling).toBe(screen.getByTestId('virtualizer'))
    expect(screen.getByTestId('virtualizer')).toHaveAttribute('data-start-margin', '44')
  })

  it('passes prepend shift compensation to virtua', () => {
    runtimeMockState.shift = true

    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={(item) => <span>{item}</span>}
      />
    )

    expect(screen.getByTestId('virtualizer')).toHaveAttribute('data-shift', 'true')
  })

  it('provides the runtime-owned wheel boundary to message content', () => {
    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={() => <ScrollRuntimeBoundaryProbe />}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'notify wheel' }))
    fireEvent.click(screen.getByRole('button', { name: 'scroll by wheel' }))

    expect(runtimeMockState.notifyWheelIntent).toHaveBeenCalledWith(40)
    expect(runtimeMockState.scrollByWheel).toHaveBeenCalledWith(80)
  })

  it('registers wheel handling as a native passive listener', async () => {
    const addEventListenerSpy = vi.spyOn(HTMLElement.prototype, 'addEventListener')

    try {
      render(
        <MessageVirtualList
          items={['message-1']}
          getItemKey={(item) => item}
          renderItem={(item) => <span>{item}</span>}
        />
      )

      await waitFor(() => {
        expect(addEventListenerSpy).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: true })
      })
    } finally {
      addEventListenerSpy.mockRestore()
    }
  })

  it('leaves wheel input inside a scrollable message region there until it reaches the boundary', () => {
    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={() => (
          <div data-testid="nested-scroll-region" style={{ overflowY: 'auto' }}>
            <span data-testid="nested-scroll-content">content</span>
          </div>
        )}
      />
    )

    const region = screen.getByTestId('nested-scroll-region')
    const content = screen.getByTestId('nested-scroll-content')
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 300 })

    region.scrollTop = 50
    fireEvent.wheel(content, { deltaY: 40 })
    expect(runtimeMockState.onWheel).not.toHaveBeenCalled()
    expect(runtimeMockState.takeUserControl).not.toHaveBeenCalled()

    region.scrollTop = 200
    fireEvent.wheel(content, { deltaY: 40 })
    expect(runtimeMockState.onWheel).toHaveBeenCalledTimes(1)
  })

  it('keeps boundary wheel input in a contained nested scroller only while it has overflow', () => {
    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={() => (
          <div data-testid="nested-scroll-region" style={{ overflowY: 'auto', overscrollBehaviorY: 'contain' }}>
            <span data-testid="nested-scroll-content">content</span>
          </div>
        )}
      />
    )

    const region = screen.getByTestId('nested-scroll-region')
    const content = screen.getByTestId('nested-scroll-content')
    let scrollHeight = 300
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(region, 'scrollHeight', { configurable: true, get: () => scrollHeight })

    region.scrollTop = 200
    fireEvent.wheel(content, { deltaY: 40 })
    expect(runtimeMockState.onWheel).not.toHaveBeenCalled()
    expect(runtimeMockState.takeUserControl).not.toHaveBeenCalled()

    scrollHeight = 100
    region.scrollTop = 0
    fireEvent.wheel(content, { deltaY: 40 })
    expect(runtimeMockState.onWheel).toHaveBeenCalledTimes(1)
  })

  it('keeps nested scrollbar and keyboard scrolling independent from the outer runtime', () => {
    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={() => (
          <div data-testid="nested-scroll-region" style={{ overflowY: 'auto' }}>
            <span data-testid="nested-scroll-content">content</span>
          </div>
        )}
      />
    )

    const scroller = document.querySelector('[data-message-virtual-list-scroller]') as HTMLElement
    const region = screen.getByTestId('nested-scroll-region')
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 300 })

    // A nested scroll with no preceding input (layout / streaming content)
    // must not flip the outer list out of following.
    fireEvent.scroll(region)
    expect(runtimeMockState.takeUserControl).not.toHaveBeenCalled()

    // Pointer drags and keyboard input owned by the nested scroller must not
    // seed the outer runtime either.
    fireEvent.pointerDown(region)
    fireEvent.pointerMove(region, { buttons: 1 })
    fireEvent.scroll(region)
    fireEvent.keyDown(region, { key: 'PageDown' })
    expect(runtimeMockState.takeUserControl).not.toHaveBeenCalled()
    expect(runtimeMockState.markUserInput).not.toHaveBeenCalled()
    fireEvent.pointerUp(document)

    // The outer scroller's own scroll events stay with the runtime's handlers.
    runtimeMockState.takeUserControl.mockClear()
    fireEvent.scroll(scroller)
    expect(runtimeMockState.takeUserControl).not.toHaveBeenCalled()
  })

  it('hands keyboard and touch scrolling to the outer runtime at a nested boundary', () => {
    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={() => (
          <div data-testid="nested-scroll-region" style={{ overflowY: 'auto' }}>
            content
          </div>
        )}
      />
    )

    const region = screen.getByTestId('nested-scroll-region')
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 300 })
    region.scrollTop = 200

    fireEvent.keyDown(region, { key: 'PageDown' })
    expect(runtimeMockState.markUserInput).toHaveBeenCalledTimes(1)

    runtimeMockState.markUserInput.mockClear()
    const fireTouchPointerEvent = (type: 'pointerdown' | 'pointermove', clientY: number, buttons: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        buttons: { value: buttons },
        clientY: { value: clientY },
        pointerType: { value: 'touch' }
      })
      fireEvent(region, event)
    }
    // jsdom has no PointerEvent constructor, so Testing Library otherwise
    // falls back to Event and silently drops pointer-specific init fields.
    fireTouchPointerEvent('pointerdown', 100, 1)
    fireTouchPointerEvent('pointermove', 80, 1)
    expect(runtimeMockState.markUserInput).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(document)

    runtimeMockState.markUserInput.mockClear()
    region.style.overscrollBehaviorY = 'contain'
    fireEvent.keyDown(region, { key: 'PageDown' })
    expect(runtimeMockState.markUserInput).not.toHaveBeenCalled()
  })

  describe('keyboard scrolling', () => {
    const PAGE_PX = 500 * 0.9
    const LINE_PX = 48

    // Mirrors the real chat view: the list and the composer are siblings under
    // the chat shell's center column, and a dialog portals outside of it.
    const renderChatView = () => {
      render(
        <>
          <div data-chat-app-shell-center>
            <MessageVirtualList
              items={['message-1']}
              getItemKey={(item) => item}
              renderItem={(item) => <span>{item}</span>}
            />
            <div contentEditable data-testid="composer" suppressContentEditableWarning>
              draft
            </div>
          </div>
          <div role="dialog">
            <input data-testid="dialog-input" />
          </div>
        </>
      )
      const scroller = document.querySelector('[data-message-virtual-list-scroller]') as HTMLElement
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 })
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2_000 })
      scroller.scrollTop = 100
      return scroller
    }

    // The scroller is not focusable, so the keys land on the body — native
    // scrolling never reaches the message viewport there.
    it('scrolls the message viewport for keys pressed with no focused widget', () => {
      const scroller = renderChatView()

      fireEvent.keyDown(document.body, { key: 'PageDown' })
      expect(scroller.scrollTop).toBeCloseTo(100 + PAGE_PX)

      fireEvent.keyDown(document.body, { key: 'ArrowUp' })
      expect(scroller.scrollTop).toBeCloseTo(100 + PAGE_PX - LINE_PX)
    })

    it('sends Home and End through the runtime instead of a pixel delta', () => {
      renderChatView()

      fireEvent.keyDown(document.body, { key: 'End' })
      expect(runtimeMockState.scrollToBottom).toHaveBeenCalledTimes(1)

      fireEvent.keyDown(document.body, { key: 'Home' })
      expect(runtimeMockState.scrollToTop).toHaveBeenCalledTimes(1)
      expect(runtimeMockState.scrollByOffset).not.toHaveBeenCalled()
    })

    // The composer takes focus back on its own, so this is where the user
    // actually presses these keys.
    it('pages the transcript from the composer without disturbing the caret keys', () => {
      const scroller = renderChatView()
      const composer = screen.getByTestId('composer')

      for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) fireEvent.keyDown(composer, { key })
      expect(scroller.scrollTop).toBe(100)
      expect(runtimeMockState.scrollByOffset).not.toHaveBeenCalled()
      expect(runtimeMockState.scrollToTop).not.toHaveBeenCalled()
      expect(runtimeMockState.scrollToBottom).not.toHaveBeenCalled()

      fireEvent.keyDown(composer, { key: 'PageDown' })
      expect(scroller.scrollTop).toBeCloseTo(100 + PAGE_PX)
    })

    it('leaves an editor outside this chat view alone', () => {
      const scroller = renderChatView()

      fireEvent.keyDown(screen.getByTestId('dialog-input'), { key: 'PageDown' })

      expect(scroller.scrollTop).toBe(100)
      expect(runtimeMockState.scrollByOffset).not.toHaveBeenCalled()
    })

    it('yields to handlers that already claimed the key or to shortcut modifiers', () => {
      const scroller = renderChatView()

      const claimed = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true })
      claimed.preventDefault()
      document.body.dispatchEvent(claimed)

      fireEvent.keyDown(document.body, { key: 'ArrowDown', ctrlKey: true })
      fireEvent.keyDown(document.body, { key: 'End', metaKey: true })

      expect(scroller.scrollTop).toBe(100)
      expect(runtimeMockState.scrollByOffset).not.toHaveBeenCalled()
      expect(runtimeMockState.scrollToBottom).not.toHaveBeenCalled()
    })
  })

  it('ignores purely horizontal wheel input instead of taking scroll ownership', () => {
    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={(item) => <span>{item}</span>}
      />
    )

    const scroller = document.querySelector('[data-message-virtual-list-scroller]') as HTMLElement
    fireEvent.wheel(scroller, { deltaY: 0, deltaX: 40 })
    expect(runtimeMockState.onWheel).not.toHaveBeenCalled()
    expect(runtimeMockState.takeUserControl).not.toHaveBeenCalled()
  })

  it('marks scroll intent only for pointer drags that pressed inside the scroller', () => {
    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={(item) => <span>{item}</span>}
      />
    )

    const scroller = document.querySelector('[data-message-virtual-list-scroller]') as HTMLElement

    // A drag entering from outside (text selection started in the composer)
    // must not count as scroll intent.
    fireEvent.pointerMove(scroller, { buttons: 1 })
    expect(runtimeMockState.markUserInput).not.toHaveBeenCalled()

    fireEvent.pointerDown(screen.getByTestId('item-0'))
    fireEvent.pointerMove(scroller, { buttons: 1 })
    expect(runtimeMockState.markUserInput).toHaveBeenCalledTimes(1)

    // Releasing anywhere ends the gesture, even off-list.
    fireEvent.pointerUp(document)
    fireEvent.pointerMove(scroller, { buttons: 1 })
    expect(runtimeMockState.markUserInput).toHaveBeenCalledTimes(1)
  })

  it('keeps native scrollbar drag ownership until the pointer is released', () => {
    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={(item) => <span>{item}</span>}
      />
    )

    const scroller = document.querySelector('[data-message-virtual-list-scroller]') as HTMLElement
    fireEvent.pointerDown(scroller)
    expect(runtimeMockState.beginScrollbarDrag).toHaveBeenCalledTimes(1)
    expect(runtimeMockState.endScrollbarDrag).not.toHaveBeenCalled()

    fireEvent.pointerUp(document)
    expect(runtimeMockState.endScrollbarDrag).toHaveBeenCalledTimes(1)
  })

  it('records only scroll intent from ordinary input and removes the listeners on unmount', () => {
    const { unmount } = render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={(item) => <span>{item}</span>}
      />
    )

    const scroller = document.querySelector('[data-message-virtual-list-scroller]') as HTMLElement
    expect(scroller).toBeTruthy()
    const removeSpy = vi.spyOn(scroller, 'removeEventListener')
    const documentRemoveSpy = vi.spyOn(document, 'removeEventListener')

    const item = screen.getByTestId('item-0')
    fireEvent.pointerDown(item)
    fireEvent.keyDown(scroller, { key: 'PageDown' })
    fireEvent.pointerMove(scroller, { buttons: 1 })
    expect(runtimeMockState.markUserInput).toHaveBeenCalledTimes(2)
    expect(runtimeMockState.takeUserControl).not.toHaveBeenCalled()

    unmount()
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    // A document-level listener outlives the component unless it is torn down,
    // so an unmounted list would keep hijacking every scroll key in the app.
    expect(documentRemoveSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    documentRemoveSpy.mockRestore()

    runtimeMockState.scrollByOffset.mockClear()
    fireEvent.keyDown(document.body, { key: 'PageDown' })
    expect(runtimeMockState.scrollByOffset).not.toHaveBeenCalled()
  })

  it('renders a scroll-to-bottom button when the runtime is far from bottom', () => {
    runtimeMockState.isScrollToBottomButtonVisible = true

    render(
      <MessageVirtualList
        items={['message-1']}
        getItemKey={(item) => item}
        renderItem={(item) => <span>{item}</span>}
        showScrollToBottomButton
        scrollToBottomButtonBottomOffset={88}
      />
    )

    const button = screen.getByTestId('message-scroll-to-bottom-button')
    expect(button).toHaveAttribute('aria-label', 'chat.navigation.bottom')
    expect(button).toHaveClass('h-9', 'w-9')
    expect(screen.getByTestId('scroll-arrow-icon')).toBeInTheDocument()
    expect(document.querySelector('[data-message-scroll-to-bottom-button-layer]')).toHaveClass('z-5')
    expect(document.querySelector('[data-message-scroll-to-bottom-button-layer]')).toHaveStyle({ bottom: '88px' })

    fireEvent.click(button)

    expect(runtimeMockState.scrollToBottom).toHaveBeenCalledWith()
  })
})
