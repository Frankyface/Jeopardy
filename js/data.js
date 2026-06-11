// Fallback game data used when questions.json cannot be fetched (e.g. when
// index.html is opened directly from disk). Keep manually in sync with questions.json.
const DEFAULT_GAME = {
  "title": "Game Night Jeopardy",
  "categories": [
    {
      "name": "Science & Nature",
      "clues": [
        { "value": 200, "clue": "This planet is known as the Red Planet.", "answer": "What is Mars?" },
        { "value": 400, "clue": "H2O is the chemical formula for this everyday substance.", "answer": "What is water?" },
        { "value": 600, "clue": "This force keeps the planets in orbit around the Sun.", "answer": "What is gravity?" },
        { "value": 800, "clue": "The powerhouse of the cell.", "answer": "What is the mitochondria?" },
        { "value": 1000, "clue": "This scientist published the theory of general relativity in 1915.", "answer": "Who is Albert Einstein?" }
      ]
    },
    {
      "name": "World Capitals",
      "clues": [
        { "value": 200, "clue": "The capital of France.", "answer": "What is Paris?" },
        { "value": 400, "clue": "The capital of Japan.", "answer": "What is Tokyo?" },
        { "value": 600, "clue": "The capital of Australia (it's not Sydney).", "answer": "What is Canberra?" },
        { "value": 800, "clue": "The capital of Canada.", "answer": "What is Ottawa?", "dailyDouble": true },
        { "value": 1000, "clue": "This city has been the capital of two different countries: Czechoslovakia and the Czech Republic.", "answer": "What is Prague?" }
      ]
    },
    {
      "name": "Movie Lines",
      "clues": [
        { "value": 200, "clue": "\"May the Force be with you\" comes from this 1977 film.", "answer": "What is Star Wars?" },
        { "value": 400, "clue": "\"I'll be back\" is the signature line of this 1984 sci-fi classic.", "answer": "What is The Terminator?" },
        { "value": 600, "clue": "\"Here's looking at you, kid\" was said in this 1942 wartime romance.", "answer": "What is Casablanca?" },
        { "value": 800, "clue": "\"You can't handle the truth!\" was shouted by Jack Nicholson in this 1992 courtroom drama.", "answer": "What is A Few Good Men?" },
        { "value": 1000, "clue": "\"I'm gonna make him an offer he can't refuse\" is the most famous line from this 1972 crime saga.", "answer": "What is The Godfather?" }
      ]
    },
    {
      "name": "Food & Drink",
      "clues": [
        { "value": 200, "clue": "This Italian dish is a flatbread topped with tomato sauce and cheese.", "answer": "What is pizza?" },
        { "value": 400, "clue": "Guacamole is made primarily from this fruit.", "answer": "What is an avocado?" },
        { "value": 600, "clue": "This Japanese rice wine is traditionally served warm or chilled.", "answer": "What is sake?" },
        { "value": 800, "clue": "Sauerkraut is made by fermenting this vegetable.", "answer": "What is cabbage?" },
        { "value": 1000, "clue": "This spice, made from crocus flower stigmas, is the most expensive in the world by weight.", "answer": "What is saffron?" }
      ]
    },
    {
      "name": "Sports",
      "clues": [
        { "value": 200, "clue": "The number of players on a soccer team on the field at one time.", "answer": "What is eleven?" },
        { "value": 400, "clue": "This sport awards the Green Jacket to the winner of the Masters.", "answer": "What is golf?" },
        { "value": 600, "clue": "In rugby union, a try is worth this many points.", "answer": "What is five?" },
        { "value": 800, "clue": "This country has won the most FIFA World Cups.", "answer": "What is Brazil?" },
        { "value": 1000, "clue": "The modern Olympic Games were revived in this year, in Athens.", "answer": "What is 1896?" }
      ]
    }
  ],
  "finalJeopardy": {
    "category": "World History",
    "clue": "This wall, begun in the 7th century BC and extended for over 13,000 miles, is the longest structure ever built by humans.",
    "answer": "What is the Great Wall of China?"
  }
};
