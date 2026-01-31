import { useState } from 'react';
import HomeScreen from "./HomeScreen";
import StoryCardsGame from "./StoryCardsGame";
import TriviaGame from "./TriviaGame";
import MessengerChat from "./MessengerChat";

type LangSpec = { code: string; name: string };

function App() {
  const [currentMode, setCurrentMode] = useState<'home' | 'story' | 'trivia' | 'messenger'>('home');
  const [selectedFluent, setSelectedFluent] = useState<LangSpec>({ code: "en", name: "English" });
  const [selectedLearning, setSelectedLearning] = useState<LangSpec>({ code: "es", name: "Spanish" });

  function handleSelectMode(mode: 'story' | 'trivia' | 'messenger', fluent: LangSpec, learning: LangSpec) {
    setSelectedFluent(fluent);
    setSelectedLearning(learning);
    setCurrentMode(mode);
  }

  function handleBack() {
    setCurrentMode('home');
  }

  return (
    <>
      {currentMode === 'home' && (
        <HomeScreen onSelectMode={handleSelectMode} />
      )}

      {currentMode === 'story' && (
        <StoryCardsGame
          fluent={selectedFluent}
          learning={selectedLearning}
          onBack={handleBack}
        />
      )}

      {currentMode === 'trivia' && (
        <TriviaGame
          fluent={selectedFluent}
          learning={selectedLearning}
          onBack={handleBack}
        />
      )}

      {currentMode === 'messenger' && (
        <MessengerChat
          fluent={selectedFluent}
          learning={selectedLearning}
          onBack={handleBack}
        />
      )}
    </>
  );
}

export default App
/*
      <div>
        <a href="https://vite.dev" target="_blank">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>Vite + React</h1>
      <div className="card">
        <button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <p className="read-the-docs">
        Click on the Vite and React logos to learn more
      </p>
*/