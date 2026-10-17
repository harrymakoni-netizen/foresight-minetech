import unittest
from .policy import equipment,EventMachine,Tracker,point_polygon
class PolicyTests(unittest.TestCase):
    def person(self):return {'trackId':'1','box':[20,10,100,190],'confidence':.9}
    def test_absence_is_unknown(self):
        p=self.person();self.assertEqual(equipment(p,[],200,200,100,[p])['helmet']['state'],'cannot-assess')
    def test_visible_positive_and_negative(self):
        p=self.person();d=[{'class':'helmet','box':[40,20,80,45],'confidence':.9},{'class':'no-vest','box':[35,65,85,130],'confidence':.9}];r=equipment(p,d,200,200,100,[p]);self.assertEqual(r['helmet']['state'],'observed');self.assertEqual(r['vest']['state'],'potentially-missing')
    def test_darkness_overlap_and_clipping(self):
        p=self.person();d=[{'class':'no-helmet','box':[40,20,80,45],'confidence':.9}]
        self.assertEqual(equipment(p,d,200,200,20,[p])['helmet']['state'],'cannot-assess')
        other={**p,'trackId':'2'};self.assertEqual(equipment(p,d,200,200,100,[p,other])['helmet']['state'],'cannot-assess')
        p['box'][1]=0;self.assertEqual(equipment(p,d,200,200,100,[p])['helmet']['state'],'cannot-assess')
    def test_persistence_and_dedup(self):
        m=EventMachine();self.assertIsNone(m.ppe('1','helmet','potentially-missing',0,'f0'));self.assertIsNone(m.ppe('1','helmet','potentially-missing',.5,'f1'));a=m.ppe('1','helmet','potentially-missing',1,'f2');b=m.ppe('1','helmet','potentially-missing',1.2,'f3');self.assertEqual(a['eventId'],b['eventId']);self.assertEqual(len(m.events),1)
    def test_quality_suspends_candidate_and_new_interval(self):
        m=EventMachine();m.ppe('1','helmet','potentially-missing',0,'f');m.ppe('1','helmet','cannot-assess',.5,'f');self.assertIsNone(m.ppe('1','helmet','potentially-missing',1,'f'));self.assertIsNone(m.ppe('1','helmet','potentially-missing',1.5,'f'));self.assertIsNotNone(m.ppe('1','helmet','potentially-missing',2,'f'))
    def test_entry_jitter_and_reentry(self):
        m=EventMachine();self.assertIsNone(m.entry('1','inside',0,'f'));m.entry('1','outside',.2,'f');m.entry('1','boundary',.3,'f');self.assertIsNotNone(m.entry('1','inside',.4,'f'));self.assertIsNone(m.entry('1','inside',.6,'f'));m.entry('1','outside',1,'f');self.assertIsNotNone(m.entry('1','inside',1.1,'f'));self.assertEqual(len(m.events),2)
    def test_polygon_and_feed_loss(self):
        polygon=[[0,0],[100,0],[100,100],[0,100]];self.assertEqual(point_polygon((50,50),polygon),'inside');self.assertEqual(point_polygon((1,50),polygon),'boundary');self.assertEqual(point_polygon((120,50),polygon),'outside');m=EventMachine();m.entry('1','outside',0,'f');m.feed_loss();self.assertIsNone(m.entry('1','inside',1,'f'))
    def test_tracks_expire_session_local(self):
        t=Tracker();p=self.person();a=t.update([p],0)[0]['trackId'];self.assertEqual(t.update([p],.5)[0]['trackId'],a);self.assertNotEqual(t.update([p],3)[0]['trackId'],a)
if __name__=='__main__':unittest.main()
