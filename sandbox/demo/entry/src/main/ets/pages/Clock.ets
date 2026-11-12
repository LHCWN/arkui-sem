import { emitter } from '@kit.BasicServicesKit'

@Entry
@Component
struct Clock {
  @State now: string = new Date().toLocaleTimeString()
  @State zone: string = 'UTC'

  aboutToAppear(): void {
    emitter.on('zoneChanged', (event: emitter.EventData) => {
      this.zone = `${event.data?.zone}`
    })
  }

  build() {
    Column() {
      Text(this.now)
      Text(this.zone)
    }
  }
}
