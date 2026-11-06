import { Body } from 'common';

@Component
export struct BodyView {
  @ObjectLink body: Body;

  build() {
    Text(this.body.text)
  }
}
