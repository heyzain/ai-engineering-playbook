import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface PromptInterface {
  ask(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  select<T extends string>(question: string, options: readonly T[], defaultValue: T): Promise<T>;
  close(): void;
}

export class TerminalPrompter implements PromptInterface {
  private rl: readline.Interface | null = null;

  private getRl(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({ input, output });
    }
    return this.rl;
  }

  public async ask(question: string, defaultValue?: string): Promise<string> {
    const rl = this.getRl();
    const promptText = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    const answer = await rl.question(promptText);
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : defaultValue || "";
  }

  public async confirm(question: string, defaultYes = false): Promise<boolean> {
    const rl = this.getRl();
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    const answer = await rl.question(`${question} ${hint}: `);
    const trimmed = answer.trim().toLowerCase();
    if (!trimmed) {
      return defaultYes;
    }
    return trimmed === "y" || trimmed === "yes";
  }

  public async select<T extends string>(
    question: string,
    options: readonly T[],
    defaultValue: T
  ): Promise<T> {
    const rl = this.getRl();
    const optionsText = options.join(" / ");
    const promptText = `${question} (${optionsText}) [${defaultValue}]: `;
    while (true) {
      const answer = await rl.question(promptText);
      const trimmed = answer.trim().toLowerCase() as T;
      if (!trimmed) {
        return defaultValue;
      }
      if (options.includes(trimmed)) {
        return trimmed;
      }
      console.log(`Invalid option "${answer.trim()}". Allowed choices: ${options.join(", ")}`);
    }
  }

  public close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}
