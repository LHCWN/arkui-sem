import { Card } from 'common';

@Entry
@ComponentV2
struct CardPage {
  @Local card: Card = new Card();

  build() {
    Column() {
      Text(this.card.title)
      Button('edit').onClick(() => {
        this.card.title = 'edited';
      })
    }
  }
}
