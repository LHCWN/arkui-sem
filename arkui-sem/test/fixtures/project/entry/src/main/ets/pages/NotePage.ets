import { Note } from 'common';
import { BodyView } from '../components/BodyView';

@Entry
@Component
struct NotePage {
  @State note: Note = new Note();

  build() {
    Column() {
      BodyView({ body: this.note.body })
      Button('edit').onClick(() => {
        this.note.body.text = 'edited';
      })
    }
  }
}
