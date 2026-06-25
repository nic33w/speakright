export type PivotReply = {
  id: string;
  text_native: string;
  text_target: string;
};

export type Pivot = {
  id: string;
  opening_message: string;
  audio_message: string;
  audio_message_translation: string;
  quick_replies: PivotReply[];
};

export const PIVOTS: Pivot[] = [
  {
    id: "sombongo_pivot_01",
    opening_message: "I just caught my reflection and, wow... I almost complimented myself out loud. Be honest, what do you think is my best feature?",
    audio_message: "¿Qué es lo mejor de mí?",
    audio_message_translation: "What's the best thing about me?",
    quick_replies: [
      { id: "r1", text_native: "Definitely your confidence", text_target: "Definitivamente tu confianza" },
      { id: "r2", text_native: "Your style is unmatched", text_target: "Tu estilo no tiene competencia" },
      { id: "r3", text_native: "Those mushroom vibes for sure", text_target: "Esas vibras de hongo, sin duda" },
      { id: "r4", text_native: "Honestly, everything about you", text_target: "Honestamente, todo en ti" },
    ],
  },
  {
    id: "sombongo_pivot_02",
    opening_message: "Someone claimed mushrooms aren't stylish. Can you believe that? Settle this argument for me.",
    audio_message: "¿Quién tiene razón?",
    audio_message_translation: "Who's right?",
    quick_replies: [
      { id: "r1", text_native: "Mushrooms are totally stylish!", text_target: "¡Los hongos son súper elegantes!" },
      { id: "r2", text_native: "Who said that? They're wrong", text_target: "¿Quién dijo eso? Está equivocado" },
      { id: "r3", text_native: "It depends on how you wear them", text_target: "Depende de cómo los usas" },
      { id: "r4", text_native: "You're right, mushrooms are chic", text_target: "Tienes razón, los hongos son chic" },
    ],
  },
  {
    id: "sombongo_pivot_03",
    opening_message: "If I started my own kingdom, what should I name it? Obviously it would be magnificent.",
    audio_message: "Dame una idea.",
    audio_message_translation: "Give me an idea.",
    quick_replies: [
      { id: "r1", text_native: "The Kingdom of Sombongo!", text_target: "¡El Reino de Sombongo!" },
      { id: "r2", text_native: "How about Sombrerolandia?", text_target: "¿Qué tal Sombrerolandia?" },
      { id: "r3", text_native: "Land of the Magnificent Mushroom", text_target: "La Tierra del Hongo Magnífico" },
      { id: "r4", text_native: "Something with 'grand' in it", text_target: "Algo con 'grandioso' en el nombre" },
    ],
  },
  {
    id: "sombongo_pivot_04",
    opening_message: "I found a tiny bird sitting on my sombrero this morning. Should I charge it rent?",
    audio_message: "¿Tú qué harías?",
    audio_message_translation: "What would you do?",
    quick_replies: [
      { id: "r1", text_native: "Yes, charge it rent!", text_target: "¡Sí, cóbrale renta!" },
      { id: "r2", text_native: "Maybe it just likes your hat", text_target: "Tal vez solo le gusta tu sombrero" },
      { id: "r3", text_native: "I'd let it stay for free", text_target: "Yo lo dejaría quedarse gratis" },
      { id: "r4", text_native: "Offer it a tiny lease agreement", text_target: "Ofrécele un pequeño contrato" },
    ],
  },
  {
    id: "sombongo_pivot_05",
    opening_message: "I'm thinking of inventing a holiday dedicated entirely to celebrating me. What activities should people do?",
    audio_message: "Suena divertido, ¿no?",
    audio_message_translation: "Sounds fun, doesn't it?",
    quick_replies: [
      { id: "r1", text_native: "Parades and speeches!", text_target: "¡Desfiles y discursos!" },
      { id: "r2", text_native: "Everyone wears sombreros all day", text_target: "Todos usan sombreros todo el día" },
      { id: "r3", text_native: "A mushroom feast sounds perfect", text_target: "Un festín de hongos suena perfecto" },
      { id: "r4", text_native: "Dancing and storytelling all day", text_target: "Baile y cuentos todo el día" },
    ],
  },
  {
    id: "sombongo_pivot_06",
    opening_message: "I challenged a squirrel to a staring contest. It blinked first... probably. Should I count that as a victory?",
    audio_message: "¿Gané o no?",
    audio_message_translation: "Did I win or not?",
    quick_replies: [
      { id: "r1", text_native: "That definitely counts as a win", text_target: "Eso definitivamente cuenta como victoria" },
      { id: "r2", text_native: "Squirrels blink all the time", text_target: "Las ardillas parpadean todo el tiempo" },
      { id: "r3", text_native: "I would've blinked first honestly", text_target: "Yo hubiera parpadeado primero, honestamente" },
      { id: "r4", text_native: "It's your victory, claim it!", text_target: "¡Es tu victoria, reclámala!" },
    ],
  },
  {
    id: "sombongo_pivot_07",
    opening_message: "I'm redesigning my black mushroom sombrero. What tiny detail would make it even more legendary?",
    audio_message: "¿Qué cambiarías?",
    audio_message_translation: "What would you change?",
    quick_replies: [
      { id: "r1", text_native: "Add some tiny mushroom lights", text_target: "Agrega unas lucecitas de hongo" },
      { id: "r2", text_native: "A velvet ribbon would be perfect", text_target: "Una cinta de terciopelo sería perfecta" },
      { id: "r3", text_native: "Maybe some golden stitching", text_target: "Tal vez unos bordados dorados" },
      { id: "r4", text_native: "Keep it simple, less is more", text_target: "Mantenlo simple, menos es más" },
    ],
  },
  {
    id: "sombongo_pivot_08",
    opening_message: "Imagine you had to describe me using only three words. Choose wisely.",
    audio_message: "Solo tres palabras.",
    audio_message_translation: "Just three words.",
    quick_replies: [
      { id: "r1", text_native: "Bold, charming, unforgettable", text_target: "Audaz, encantador, inolvidable" },
      { id: "r2", text_native: "Eccentric, stylish, confident", text_target: "Excéntrico, elegante, seguro" },
      { id: "r3", text_native: "Unique, dramatic, legendary", text_target: "Único, dramático, legendario" },
      { id: "r4", text_native: "Funny, kind, and a little weird", text_target: "Gracioso, amable y un poco raro" },
    ],
  },
  {
    id: "sombongo_pivot_09",
    opening_message: "I entered a cooking contest even though I barely cook. Confidence is an ingredient, right?",
    audio_message: "¿Crees que puedo ganar?",
    audio_message_translation: "Do you think I can win?",
    quick_replies: [
      { id: "r1", text_native: "Of course you can! Go for it!", text_target: "¡Por supuesto que puedes! ¡Hazlo!" },
      { id: "r2", text_native: "What are you going to make?", text_target: "¿Qué vas a preparar?" },
      { id: "r3", text_native: "Confidence alone might not be enough", text_target: "La confianza sola podría no ser suficiente" },
      { id: "r4", text_native: "Practice one dish first just in case", text_target: "Practica un platillo primero, por si acaso" },
    ],
  },
  {
    id: "sombongo_pivot_10",
    opening_message: "What's the most dramatic entrance you can imagine? I need ideas for my next appearance.",
    audio_message: "Sorpréndeme.",
    audio_message_translation: "Surprise me.",
    quick_replies: [
      { id: "r1", text_native: "Confetti raining from the sky!", text_target: "¡Confeti lloviendo del cielo!" },
      { id: "r2", text_native: "Arrive on a white horse", text_target: "Llegar en un caballo blanco" },
      { id: "r3", text_native: "A spotlight and your own theme music", text_target: "Un reflector y tu propia música temática" },
      { id: "r4", text_native: "Slow walk with wind in your cape", text_target: "Caminar despacio con viento en tu capa" },
    ],
  },
  {
    id: "sombongo_pivot_11",
    opening_message: "A butterfly landed on my shoulder and refused to leave. I think it recognized greatness.",
    audio_message: "¿Qué opinas?",
    audio_message_translation: "What do you think?",
    quick_replies: [
      { id: "r1", text_native: "Obviously it knew you were special", text_target: "Obviamente sabía que eras especial" },
      { id: "r2", text_native: "Butterflies have great taste", text_target: "Las mariposas tienen muy buen gusto" },
      { id: "r3", text_native: "Maybe it just liked your colors", text_target: "Tal vez solo le gustaron tus colores" },
      { id: "r4", text_native: "That's a sign of greatness for sure", text_target: "Eso es una señal de grandeza, seguro" },
    ],
  },
  {
    id: "sombongo_pivot_12",
    opening_message: "If I had my own theme song, what style of music should it be?",
    audio_message: "Elige un género.",
    audio_message_translation: "Choose a genre.",
    quick_replies: [
      { id: "r1", text_native: "Definitely mariachi!", text_target: "¡Definitivamente mariachi!" },
      { id: "r2", text_native: "Epic orchestral music for sure", text_target: "Música orquestal épica, sin duda" },
      { id: "r3", text_native: "Dramatic flamenco would suit you", text_target: "El flamenco dramático te quedaría bien" },
      { id: "r4", text_native: "Salsa, to match your energy", text_target: "Salsa, para combinar con tu energía" },
    ],
  },
  {
    id: "sombongo_pivot_13",
    opening_message: "I accidentally walked into the wrong meeting and everyone listened to me anyway. What would you have talked about?",
    audio_message: "Tengo curiosidad.",
    audio_message_translation: "I'm curious.",
    quick_replies: [
      { id: "r1", text_native: "I'd talk about mushroom fashion", text_target: "Hablaría sobre la moda de los hongos" },
      { id: "r2", text_native: "Something about self-confidence", text_target: "Algo sobre la confianza en uno mismo" },
      { id: "r3", text_native: "I'd pitch an adventure plan", text_target: "Presentaría un plan de aventura" },
      { id: "r4", text_native: "Honestly I'd just improvise", text_target: "Honestamente, solo improvisaría" },
    ],
  },
  {
    id: "sombongo_pivot_14",
    opening_message: "Suppose you could ask a talking mushroom one question. What would you ask me?",
    audio_message: "Pregunta lo que quieras.",
    audio_message_translation: "Ask whatever you want.",
    quick_replies: [
      { id: "r1", text_native: "What's the secret to being stylish?", text_target: "¿Cuál es el secreto para ser elegante?" },
      { id: "r2", text_native: "What do mushrooms dream about?", text_target: "¿De qué sueñan los hongos?" },
      { id: "r3", text_native: "Do you know any good jokes?", text_target: "¿Conoces algún buen chiste?" },
      { id: "r4", text_native: "What's your greatest adventure so far?", text_target: "¿Cuál es tu mayor aventura hasta ahora?" },
    ],
  },
  {
    id: "sombongo_pivot_15",
    opening_message: "I'm making a trophy shelf for all my future accomplishments. Which achievement should I earn first?",
    audio_message: "Escoge uno.",
    audio_message_translation: "Pick one.",
    quick_replies: [
      { id: "r1", text_native: "World's Most Stylish Sombrero", text_target: "El sombrero más elegante del mundo" },
      { id: "r2", text_native: "First to befriend every animal", text_target: "El primero en hacerse amigo de cada animal" },
      { id: "r3", text_native: "Master of dramatic entrances", text_target: "Maestro de las entradas dramáticas" },
      { id: "r4", text_native: "Official Kingdom Founder award", text_target: "Premio oficial de fundador del reino" },
    ],
  },
  {
    id: "sombongo_pivot_16",
    opening_message: "Do you think mirrors get excited when they see me, or am I overthinking it?",
    audio_message: "Sé sincero.",
    audio_message_translation: "Be honest.",
    quick_replies: [
      { id: "r1", text_native: "Of course they get excited!", text_target: "¡Por supuesto que se emocionan!" },
      { id: "r2", text_native: "Maybe just a little bit", text_target: "Tal vez solo un poquito" },
      { id: "r3", text_native: "Mirrors don't have feelings, sadly", text_target: "Los espejos no tienen sentimientos, lamentablemente" },
      { id: "r4", text_native: "I think you might be overthinking it", text_target: "Creo que podrías estar exagerando un poco" },
    ],
  },
  {
    id: "sombongo_pivot_17",
    opening_message: "I'm trying to come up with the perfect heroic nickname for myself. Got any ideas?",
    audio_message: "Ayúdame a elegir.",
    audio_message_translation: "Help me choose.",
    quick_replies: [
      { id: "r1", text_native: "The Sombrero Sentinel!", text_target: "¡El Centinela del Sombrero!" },
      { id: "r2", text_native: "How about The Mushroom Knight?", text_target: "¿Qué tal El Caballero Hongo?" },
      { id: "r3", text_native: "El Gran Magnífico sounds perfect", text_target: "El Gran Magnífico suena perfecto" },
      { id: "r4", text_native: "The Legendary Fungus Hero", text_target: "El Héroe Hongo Legendario" },
    ],
  },
  {
    id: "sombongo_pivot_18",
    opening_message: "If you could magically master one skill overnight, what would you choose?",
    audio_message: "¿Cuál escogerías?",
    audio_message_translation: "Which would you choose?",
    quick_replies: [
      { id: "r1", text_native: "Speaking every language fluently", text_target: "Hablar todos los idiomas con fluidez" },
      { id: "r2", text_native: "Playing a musical instrument perfectly", text_target: "Tocar un instrumento musical perfectamente" },
      { id: "r3", text_native: "The ability to cook anything delicious", text_target: "La habilidad de cocinar cualquier cosa deliciosa" },
      { id: "r4", text_native: "Flying, obviously!", text_target: "¡Volar, obviamente!" },
    ],
  },
  {
    id: "sombongo_pivot_19",
    opening_message: "I just saw the fluffiest cloud ever. It looked suspiciously like me. Coincidence?",
    audio_message: "¿La viste también?",
    audio_message_translation: "Did you see it too?",
    quick_replies: [
      { id: "r1", text_native: "That's definitely not a coincidence!", text_target: "¡Eso definitivamente no es coincidencia!" },
      { id: "r2", text_native: "The sky is honoring you!", text_target: "¡El cielo te está honrando!" },
      { id: "r3", text_native: "I think I did see it actually", text_target: "Creo que sí la vi, de hecho" },
      { id: "r4", text_native: "I think you might be imagining things", text_target: "Creo que podrías estar imaginando cosas" },
    ],
  },
  {
    id: "sombongo_pivot_20",
    opening_message: "Quick question: if we had to go on an adventure right now, where should we go first?",
    audio_message: "Elige un lugar.",
    audio_message_translation: "Choose a place.",
    quick_replies: [
      { id: "r1", text_native: "Let's go to the mountains!", text_target: "¡Vamos a las montañas!" },
      { id: "r2", text_native: "A forest sounds perfect", text_target: "Un bosque suena perfecto" },
      { id: "r3", text_native: "The coast, obviously!", text_target: "¡La costa, obviamente!" },
      { id: "r4", text_native: "Somewhere with amazing food", text_target: "Algún lugar con comida increíble" },
    ],
  },
  {
    id: "sombongo_pivot_21",
    opening_message: "Okay so I found this magic donut on the ground. Like it was just sitting there glowing. What do you think I should do with it?",
    audio_message: "¿Debería comérmelo?",
    audio_message_translation: "Should I eat it?",
    quick_replies: [
      { id: "r1", text_native: "Eat it! Live your best life!", text_target: "¡Cómetelo! ¡Vive tu mejor vida!" },
      { id: "r2", text_native: "Definitely don't eat it, it's glowing", text_target: "Definitivamente no te lo comas, está brillando" },
      { id: "r3", text_native: "Study it for science first", text_target: "Primero estúdialo para la ciencia" },
      { id: "r4", text_native: "Make a wish before eating it", text_target: "Pide un deseo antes de comértelo" },
    ],
  },
  {
    id: "sombongo_pivot_22",
    opening_message: "Ughh, I'm having a hard time picking the right color to wear to the festival tonight. What color do you think makes me look fabulous?",
    audio_message: "¿Puedes ayudarme?",
    audio_message_translation: "Can you help me?",
    quick_replies: [
      { id: "r1", text_native: "Deep purple is very regal", text_target: "El morado oscuro es muy regio" },
      { id: "r2", text_native: "Gold always looks fabulous", text_target: "El dorado siempre se ve fabuloso" },
      { id: "r3", text_native: "Bright red for maximum impact", text_target: "Rojo brillante para el máximo impacto" },
      { id: "r4", text_native: "Wear whatever makes you feel confident", text_target: "Usa lo que te haga sentir seguro" },
    ],
  },
  {
    id: "sombongo_pivot_23",
    opening_message: "I'm going to a costume party and I decide to dress as a planet. But which planet will make everyone envy me?",
    audio_message: "¿Qué opinas?",
    audio_message_translation: "What do you think?",
    quick_replies: [
      { id: "r1", text_native: "Saturn, the rings are iconic", text_target: "Saturno, los anillos son icónicos" },
      { id: "r2", text_native: "Jupiter, biggest and boldest", text_target: "Júpiter, el más grande y audaz" },
      { id: "r3", text_native: "Venus, the planet of beauty", text_target: "Venus, el planeta de la belleza" },
      { id: "r4", text_native: "Mars, the dramatic red planet", text_target: "Marte, el dramático planeta rojo" },
    ],
  },
];
