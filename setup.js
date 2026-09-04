import inquirer from "inquirer";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const mainQuestion = [
  {
    type: "list",
    name: "AI_SELECTED",
    message: "Escolha a IA que deseja usar:",
    choices: [
      { name: "Gemini (Google AI Studio)", value: "GEMINI_FREE" },
      { name: "GPT (OpenAI - pago)", value: "GPT" },
    ],
  },
];

const geminiQuestion = [
  {
    type: "input",
    name: "GEMINI_KEY",
    message:
      "Informe a sua GEMINI_KEY do Google AI Studio (https://aistudio.google.com/app/apikey):",
    validate: (input) =>
      !!input ||
      "A GEMINI_KEY nao pode ser vazia. Por favor, informe um valor valido.",
  },
  {
    type: "input",
    name: "GEMINI_PROMPT",
    message: "Informe o prompt para o Gemini:",
    validate: (input) =>
      !!input ||
      "A GEMINI_PROMPT nao pode ser vazia. Por favor, informe um valor valido.",
  },
];

const gptQuestions = [
  {
    type: "input",
    name: "OPENAI_KEY",
    message: "Informe a sua OPENAI_KEY (https://platform.openai.com/api-keys):",
    validate: (input) =>
      !!input ||
      "A OPENAI_KEY nao pode ser vazia. Por favor, informe um valor valido.",
  },
  {
    type: "input",
    name: "OPENAI_ASSISTANT",
    message:
      "Informe o seu OPENAI_ASSISTANT (https://platform.openai.com/assistants):",
    validate: (input) =>
      !!input ||
      "O OPENAI_ASSISTANT nao pode ser vazio. Por favor, informe um valor valido.",
  },
];

inquirer.prompt(mainQuestion).then((answers) => {
  let envConfig = `AI_SELECTED=${answers.AI_SELECTED}\n`;

  if (answers.AI_SELECTED === "GEMINI_FREE") {
    inquirer.prompt(geminiQuestion).then((geminiAnswer) => {
      envConfig += `GEMINI_KEY=${geminiAnswer.GEMINI_KEY}\nGEMINI_PROMPT=${geminiAnswer.GEMINI_PROMPT}\n`;
      fs.writeFileSync(".env", envConfig, { encoding: "utf8" });
      console.log("Configuracao para Gemini salva com sucesso!");
    });
  } else {
    inquirer.prompt(gptQuestions).then((gptAnswers) => {
      envConfig += `OPENAI_KEY=${gptAnswers.OPENAI_KEY}\nOPENAI_ASSISTANT=${gptAnswers.OPENAI_ASSISTANT}\n`;
      fs.writeFileSync(".env", envConfig, { encoding: "utf8" });
      console.log("Configuracao para GPT salva com sucesso!");
    });
  }
});
