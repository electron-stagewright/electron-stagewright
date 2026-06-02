import { Component } from '@angular/core'

// Standalone Angular component implementing the shared matrix UI contract. The input is
// bound via [value] + (input) (no FormsModule needed); the #status line is interpolated.
// Compiled at runtime by Angular's JIT compiler (main.ts imports @angular/compiler),
// driven by zone.js change detection.
@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <main>
      <h1>Angular fixture</h1>
      <label
        >Your name <input id="name" aria-label="Your name" [value]="name" (input)="onInput($event)"
      /></label>
      <button id="greet" type="button" (click)="greet()">Greet</button>
      <p id="status">{{ status }}</p>
    </main>
  `,
})
export class AppComponent {
  name = ''
  status = 'No greeting yet'

  onInput(event: Event): void {
    this.name = (event.target as HTMLInputElement).value
  }

  greet(): void {
    const who = this.name.trim() || 'stranger'
    this.status = `Hello, ${who}!`
    console.log(`greeted ${who}`)
  }
}
