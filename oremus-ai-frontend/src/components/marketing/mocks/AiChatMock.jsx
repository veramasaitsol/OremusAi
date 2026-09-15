'use client';

import { useEffect, useRef, useState } from 'react';
import { Sparkles, ArrowUp, TrendingUp } from 'lucide-react';

// Scripted, replaying AI-assistant conversation. Starts when scrolled into view
// and loops, with realistic "typing" pauses. Pure CSS animations; respects
// reduced-motion (it simply shows the full thread without delays via CSS).
const SCRIPT = [
  { who: 'user', text: 'Why did expenses jump in March?' },
  { who: 'ai', typing: 900, text: 'March expenses rose 18% MoM. The main driver was a one-off software renewal of $42k, plus higher payroll from 4 new hires.' },
  { who: 'ai', typing: 700, card: true },
  { who: 'user', text: 'Is our current ratio still healthy?' },
  { who: 'ai', typing: 800, text: 'Yes — your current ratio is 2.41 (up 0.12 QoQ). That’s well above the 1.5 healthy threshold for your sector.' },
];

function Avatar() {
  return (
    <span className="relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-cyan-500 text-white">
      <Sparkles size={13} />
    </span>
  );
}

export default function AiChatMock() {
  const [step, setStep] = useState(0);
  const [typing, setTyping] = useState(false);
  const ref = useRef(null);
  const started = useRef(false);
  const timers = useRef([]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clearAll = () => { timers.current.forEach(clearTimeout); timers.current = []; };

    function run() {
      clearAll();
      setStep(0);
      setTyping(false);
      let i = 0;
      const advance = () => {
        if (i >= SCRIPT.length) {
          timers.current.push(setTimeout(run, 2600)); // loop
          return;
        }
        const item = SCRIPT[i];
        if (item.who === 'ai' && item.typing) {
          setTyping(true);
          timers.current.push(setTimeout(() => {
            setTyping(false);
            setStep((s) => Math.max(s, i + 1));
            i += 1;
            timers.current.push(setTimeout(advance, 650));
          }, item.typing));
        } else {
          setStep((s) => Math.max(s, i + 1));
          i += 1;
          timers.current.push(setTimeout(advance, 900));
        }
      };
      timers.current.push(setTimeout(advance, 500));
    }

    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && !started.current) {
          started.current = true;
          run();
        }
      });
    }, { threshold: 0.3 });
    io.observe(el);
    return () => { io.disconnect(); clearAll(); };
  }, []);

  const visible = SCRIPT.slice(0, step);

  return (
    <div ref={ref} className="browser-frame mx-auto w-full max-w-md">
      {/* header */}
      <div className="flex items-center justify-between border-b border-navy-100 bg-white px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="glow-pulse flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-cyan-500 text-white">
            <Sparkles size={15} />
          </span>
          <div>
            <p className="text-sm font-bold text-navy-900">Oremus AI</p>
            <p className="flex items-center gap-1 text-[10px] text-navy-400">
              <span className="relative flex h-1.5 w-1.5">
                <span className="ping-slow absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Online · analyzing your data
            </p>
          </div>
        </div>
      </div>

      {/* messages — fixed height, bottom-anchored so the frame never resizes
          as the scripted thread grows or loops back to empty */}
      <div className="flex h-[360px] flex-col justify-end gap-3 overflow-hidden bg-navy-50/40 p-4">
        {visible.map((m, idx) =>
          m.who === 'user' ? (
            <div key={idx} className="chat-msg flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-brand-500 px-3.5 py-2 text-[12.5px] leading-snug text-white shadow-soft">
                {m.text}
              </div>
            </div>
          ) : m.card ? (
            <div key={idx} className="chat-msg flex items-end gap-2">
              <Avatar />
              <div className="max-w-[80%] rounded-2xl rounded-bl-sm border border-navy-100 bg-white p-3 shadow-soft">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-navy-700">Expense trend</span>
                  <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-amber-600"><TrendingUp size={9} /> +18%</span>
                </div>
                <svg viewBox="0 0 200 50" className="h-12 w-full" preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <linearGradient id="chatArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#F59E0B" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#F59E0B" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path d="M0,40 L40,36 L80,38 L120,30 L160,18 L200,8" fill="none" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" />
                  <path d="M0,40 L40,36 L80,38 L120,30 L160,18 L200,8 L200,50 L0,50 Z" fill="url(#chatArea)" />
                </svg>
              </div>
            </div>
          ) : (
            <div key={idx} className="chat-msg flex items-end gap-2">
              <Avatar />
              <div className="max-w-[80%] rounded-2xl rounded-bl-sm border border-navy-100 bg-white px-3.5 py-2 text-[12.5px] leading-snug text-navy-700 shadow-soft">
                {m.text}
              </div>
            </div>
          )
        )}

        {typing && (
          <div className="flex items-end gap-2">
            <Avatar />
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-navy-100 bg-white px-3 py-2.5 shadow-soft">
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-navy-400" style={{ animationDelay: '0ms' }} />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-navy-400" style={{ animationDelay: '150ms' }} />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-navy-400" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}
      </div>

      {/* input */}
      <div className="flex items-center gap-2 border-t border-navy-100 bg-white px-3 py-3">
        <div className="flex flex-1 items-center rounded-xl border border-navy-200 px-3 py-2 text-[12px] text-navy-400">
          Ask Oremus AI…
        </div>
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-500 text-white shadow-glow">
          <ArrowUp size={15} />
        </span>
      </div>
    </div>
  );
}
